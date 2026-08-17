import type { Route } from "next";

import { type CalendarMonth, monthKey } from "@/domain/time/calendar-month";

/**
 * Where the grid's links go and what its forms must carry.
 *
 * The table renders cells and months; it knows nothing about URLs. The page builds
 * this and hands it over, so there is one place that decides what a cell leads to
 * and one place that decides what a write returns to.
 */
export interface GridLinks {
  /**
   * `/balance/month` for one month, at the level the row belongs to: a Person's
   * row opens that Person's tab, and a משותף row the household reading.
   */
  readonly month: (month: CalendarMonth, personId: string | null) => Route;
  /** This grid, with one cell opened for entry in place. */
  readonly openCell: (categoryId: string, month: CalendarMonth) => Route;
  /** This grid, with one month's closing confirmation showing above the table. */
  readonly closing: (month: CalendarMonth) => Route;
  /** This grid with neither open — what cancelling either goes back to. */
  readonly cancel: Route;
  /** This grid with the category panel open beneath it, and with it shut again. */
  readonly openAdmin: Route;
  readonly closeAdmin: Route;
  /** The fields a form carries so that its redirect lands on this exact view. */
  readonly returnTo: Readonly<Record<string, string>>;
}

/** One cell of the grid, named the same way in the URL and in the markup. */
export function cellKey(categoryId: string, month: CalendarMonth): string {
  return `${categoryId}@${monthKey(month)}`;
}
