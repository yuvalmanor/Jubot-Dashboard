import type { Route } from "next";

import { type ShareSlice, type YearGrid } from "@/domain/ledger/year-grid";

import { Segmented } from "./chrome";
import { type Currency, type Money, divide, format, sum } from "@/domain/money/money";

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
 * It reads two ways, and the ring is the same ring in both: a year's total and
 * a monthly average divide by the very same months, so the wedges are identical
 * and only the figures move. That is why this is a switch over one chart rather
 * than a second chart beside it — two rings of identical proportions would be
 * one picture printed twice, and the question "is 70,794 a lot" is a different
 * question from "is 7,079 a month a lot" only in the units.
 *
 * Colour does two jobs and no more. A Group carries an accent, because a Group
 * is an identity the household chose and put a name to. Everything else is one
 * hue, darkest first, because rank is the only thing that distinguishes an
 * ungrouped line from its neighbour — fifteen invented hues would be fifteen
 * identities nobody asked for, and under colour-blindness most of them would be
 * the same hue anyway.
 */

/**
 * Eight hues, and a ninth neutral for the tail.
 *
 * It was one hue, darkest first, on the reasoning that rank is the only thing
 * separating one ungrouped line from the next. The household read a ring of
 * twenty-three reds and said it was not a split, it was a gradient — which is
 * fair, and the fix is a real categorical palette rather than more reds.
 *
 * Eight *hues* is the ceiling and not a preference. These eight clear every hard
 * gate against this surface on the adjacent pairlist, which is the right
 * pairlist for a ring because wedges touch their neighbours: worst adjacent
 * separation ΔE 9.1 under protanopia and 19.6 with full colour vision. A ninth
 * invented hue would be indistinguishable from one of these under
 * colour-blindness, so there is not one.
 *
 * The ninth to sixteenth wedges take the same eight hues again, mixed halfway to
 * the surface. That is a tint and not a new hue: it separates on lightness,
 * which is the one channel every kind of colour-blindness keeps. It is a
 * compromise and worth naming as one — at sixteen wedges colour has stopped
 * being an identity and become a way of telling one sliver from the next — and
 * it is only sound because the ranked list beside the ring names every wedge and
 * prints its figure, so nothing here is ever identified by colour alone. The
 * same relief is what allows three of the eight to sit under 3:1 against the
 * surface.
 *
 * Past the sixteenth, the tail folds into אחר, which opens in the list onto the
 * lines inside it exactly as a Group does. The way to have fewer wedges is to
 * mark more lines into a Group, which is what Groups are for.
 */
const WEDGE_HUES = [
  "#2a78d6",
  "#eb6834",
  "#1baf7a",
  "#eda100",
  "#e87ba4",
  "#008300",
  "#6250d6",
  "#e34948",
] as const;

/** The tail. Deliberately the one colour on the ring that is not an identity. */
const TAIL_COLOUR = "#a8a29e";

/** How far the second lap is mixed towards the surface. */
const TINT = 0.5;

/** `#rrggbb` mixed towards white. Not a new hue — the same one, lighter. */
function tint(hex: string, towards: number): string {
  const channel = (at: number) => {
    const value = Number.parseInt(hex.slice(at, at + 2), 16);
    return Math.round(value + (255 - value) * towards)
      .toString(16)
      .padStart(2, "0");
  };
  return `#${channel(1)}${channel(3)}${channel(5)}`;
}

/** Sixteen fills: the eight hues, then the same eight lighter. */
const WEDGE_FILLS: readonly string[] = [
  ...WEDGE_HUES,
  ...WEDGE_HUES.map((hue) => tint(hue, TINT)),
];

/** What the folded tail is called, and the key it is drawn under. */
const TAIL_NAME = "אחר";
const TAIL_KEY = "tail:other";

/** Degrees of surface left between two wedges, so adjacent fills never touch. */
const WEDGE_GAP = 1.2;

const RADIUS = 56;
const THICKNESS = 20;
const SIZE = (RADIUS + THICKNESS / 2 + 2) * 2;

interface PaintedSlice extends ShareSlice {
  readonly colour: string;
}

/**
 * Which slices are drawn in their own colour, and what the rest become.
 *
 * A Group is never folded. It is an identity the household chose and put a name
 * to, and it carries the same colour in the table as it does here — so if קבועות
 * fell into the tail one year its rows would lose their mark for no reason the
 * reader could see. The remaining slots go to the biggest lines, and everything
 * after that becomes one אחר wedge that the list opens.
 *
 * Hues are assigned in the order the wedges are drawn, because that is the order
 * the palette was validated in: neighbours on the ring touch, and these eight
 * clear the gates as an adjacent sequence.
 */
function paint(slices: readonly ShareSlice[], currency: Currency): readonly PaintedSlice[] {
  const groups = slices.filter((slice) => slice.isGroup);
  const rest = slices.filter((slice) => !slice.isGroup);
  const kept = new Set([
    ...groups.slice(0, WEDGE_FILLS.length).map((slice) => slice.key),
    ...rest.slice(0, Math.max(0, WEDGE_FILLS.length - groups.length)).map((slice) => slice.key),
  ]);

  const drawn: PaintedSlice[] = [];
  const folded: ShareSlice[] = [];
  for (const slice of slices) {
    if (kept.has(slice.key)) {
      drawn.push({ ...slice, colour: WEDGE_FILLS[drawn.length] ?? TAIL_COLOUR });
    } else {
      folded.push(slice);
    }
  }

  if (folded.length === 0) return drawn;

  // The tail is one wedge and a dozen names. Its parts are the folded lines
  // themselves, so nothing is hidden — it is listed one level in, not dropped.
  const total = sum(
    folded.map((slice) => slice.total),
    currency,
  );
  return [
    ...drawn,
    {
      key: TAIL_KEY,
      name: `${TAIL_NAME} (${folded.length})`,
      isGroup: false,
      total,
      share: folded.reduce((running, slice) => running + (slice.share ?? 0), 0),
      parts: folded.map((slice) => ({
        key: slice.key,
        name: slice.name,
        total: slice.total,
        share: slice.share,
      })),
      colour: TAIL_COLOUR,
    },
  ];
}

/**
 * The colour each Group is drawn in, for the table to mark its rows with.
 *
 * One colour per Group across the whole screen is the only thing that makes "the
 * blue rows" and "the blue wedge" the same sentence, so the table asks the chart
 * rather than deciding for itself.
 */
export function groupColours(grid: YearGrid): ReadonlyMap<string, string> {
  const colours = new Map<string, string>();
  for (const slice of paint(grid.expenseShares, "ILS")) {
    if (slice.isGroup) colours.set(slice.name, slice.colour);
  }
  return colours;
}

/** Which figures the card prints. The wedges are the same either way. */
export type SharesBasis = "year" | "month";

export function ExpenseShares({
  grid,
  basis,
  links,
}: {
  grid: YearGrid;
  basis: SharesBasis;
  /** The same card read the other way. */
  links: { readonly year: Route; readonly month: Route };
}) {
  const months = grid.denominatorMonths.length;
  // An average over no months is undefined, not nought — the same rule every
  // other average on this screen follows — so with nothing to divide by the card
  // stays on the year's totals and the switch is not offered.
  const divisible = months > 0;
  const reading: SharesBasis = divisible ? basis : "year";
  const per = (amount: Money) => (reading === "month" ? divide(amount, months) : amount);

  const slices = paint(grid.expenseShares, "ILS").map((slice) => ({ ...slice, total: per(slice.total) }));
  const whole = per(grid.expenses.total.aggregate.total);

  const heading = (
    <Heading
      reading={reading}
      months={months}
      whole={slices.length === 0 ? null : format(whole, { withMinorUnits: false })}
      links={divisible ? links : null}
    />
  );

  if (slices.length === 0) {
    return (
      <section className="rounded-card bg-surface shadow-card p-4 sm:p-5">
        {heading}
        <p className="mt-2 text-stone-600">אין הוצאות רשומות בשנה הזו, ואין מה לפלח.</p>
      </section>
    );
  }

  return (
    <section className="rounded-card bg-surface shadow-card p-4 sm:p-5">
      {heading}

      <div className="mt-4 flex flex-col items-center gap-5 sm:flex-row sm:items-start sm:gap-7">
        <Ring slices={slices} />
        <Ranked slices={slices} />
      </div>
    </section>
  );
}

function Heading({
  reading,
  months,
  whole,
  links,
}: {
  reading: SharesBasis;
  months: number;
  whole: string | null;
  links: { readonly year: Route; readonly month: Route } | null;
}) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <h2 className="title text-[15px] font-semibold">לאן הלך הכסף</h2>
        {whole === null ? null : (
          <p className="text-[13px] text-stone-500">
            {reading === "month" ? "ממוצע חודשי" : "סך ההוצאות"}{" "}
            <bdi className="tabular font-medium text-stone-700">{whole}</bdi>
            {reading === "month" ? (
              <>
                {" · "}
                <bdi className="tabular">÷{months}</bdi>
              </>
            ) : null}
          </p>
        )}
      </div>

      {links === null ? null : (
        <Segmented
          label="איך לקרוא את הפילוח"
          size="sm"
          current={reading}
          options={[
            { key: "year", label: "סכום שנתי", href: links.year },
            { key: "month", label: "ממוצע לחודש", href: links.month },
          ]}
        />
      )}
    </div>
  );
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
          {slice.parts.length > 0 ? (
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
