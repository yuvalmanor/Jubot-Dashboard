import type { Route } from "next";
import Link from "next/link";

/**
 * The one bar of chrome above the מאזן.
 *
 * It used to be four: a card holding a year `<select>` and a submit button, a row
 * of tabs, a card of averages, and a card holding the row order. Four bands of
 * controls stood between opening the screen and seeing a figure, and two of them
 * cost a round trip to change one thing.
 *
 * Now there is one bar and everything on it is a link. Which year, whose money,
 * and the one action the screen leads to — recording a month — are the three
 * things a reader changes, and all three are one click. Everything rarer than
 * that is behind the overflow, where it does not compete.
 *
 * The two choosers are the same control: a track with the options inside it and
 * the chosen one lifted out of the track by a white tile. It is a shape people
 * already read as "one of these" without a label saying so, and it says what is
 * selected without an outline, a tick or a colour.
 */

export interface SegmentedOption {
  readonly key: string;
  readonly label: string;
  readonly href: Route;
  /** A year the ledger holds nothing for still has to be selectable. */
  readonly muted?: boolean;
}

/**
 * One of these. The chosen tile is white on the sunken track — lifted rather
 * than outlined, which is how every other surface in this application is told
 * apart from the one beneath it.
 */
export function Segmented({
  label,
  options,
  current,
  size = "md",
}: {
  label: string;
  options: readonly SegmentedOption[];
  current: string;
  size?: "sm" | "md";
}) {
  const padding = size === "sm" ? "px-2.5 py-1 text-[13px]" : "px-3.5 py-1.5 text-sm";

  return (
    <nav aria-label={label} className="inline-flex rounded-xl bg-sunken p-1">
      {options.map((option) => {
        const active = option.key === current;
        return (
          <Link
            key={option.key}
            href={option.href}
            aria-current={active ? "page" : undefined}
            className={`tabular rounded-lg font-medium transition-colors ${padding} ${
              active
                ? "bg-surface text-stone-900 shadow-[0_1px_2px_rgba(28,25,23,0.10)]"
                : option.muted
                  ? "text-stone-400 hover:text-stone-700"
                  : "text-stone-500 hover:text-stone-900"
            }`}
          >
            {option.label}
          </Link>
        );
      })}
    </nav>
  );
}

/** The dark pill. There is one of these per screen, and it is the thing to do next. */
export function PrimaryAction({ href, children }: { href: Route; children: React.ReactNode }) {
  return (
    <Link
      href={href}
      className="inline-flex items-center gap-1.5 rounded-xl bg-stone-900 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-stone-700"
    >
      {children}
    </Link>
  );
}

/**
 * Everything that is not one of the three things. A menu rather than four links
 * in a row: importing the sheet was run once and will not be run again, and a
 * screen that gives it the same weight as the year is a screen that has not
 * decided what it is for.
 *
 * `<details>` and not a script. It closes on its own when the page navigates,
 * which is the only way out of it that matters.
 */
export function OverflowMenu({
  items,
}: {
  items: readonly { readonly href: Route; readonly label: string; readonly note?: string }[];
}) {
  return (
    <details className="relative">
      <summary
        aria-label="עוד פעולות"
        className="flex h-9 w-9 cursor-pointer items-center justify-center rounded-xl text-stone-500 transition-colors hover:bg-stone-900/5 hover:text-stone-900"
      >
        <span aria-hidden="true" className="text-lg leading-none tracking-widest">
          ⋯
        </span>
      </summary>

      {/* `end-0` and not a side: the button sits at the far end of the toolbar,
          so the panel has to grow back towards the middle of the screen. Pinned
          to a physical side it would hang off the edge in one of the two
          directions, and this application is read in the one where it does. */}
      <div className="absolute end-0 top-11 z-50 w-64 rounded-card bg-surface p-1.5 shadow-[0_4px_12px_rgba(28,25,23,0.08),0_16px_40px_-12px_rgba(28,25,23,0.22)]">
        {items.map((item) => (
          <Link
            key={item.href}
            href={item.href}
            className="block rounded-lg px-3 py-2 transition-colors hover:bg-sunken"
          >
            <span className="block text-sm font-medium">{item.label}</span>
            {item.note === undefined ? null : (
              <span className="mt-0.5 block text-xs text-stone-500">{item.note}</span>
            )}
          </Link>
        ))}
      </div>
    </details>
  );
}
