/**
 * RateWatch — מעקב תעריפים, the panel that sits below the year grid.
 *
 * Framework-free per ADR 0004. Pure: the ledger is handed in, nothing is
 * fetched, and the clock is a parameter.
 *
 * The מאזן answers *where did the money go*. It does not answer *is this getting
 * more expensive, and could we phone someone and argue about it* — the question
 * behind a מכבי premium that crept 96 → 207 over three years and an internet line
 * nobody has renegotiated since it was installed. That is this reading's job.
 *
 * **It never writes the ledger, and it never adds to it.** Every figure here is a
 * *breakdown of money the grid above already holds*: a Watched Category's rate is
 * read out of the very same entries the grid's own row is read out of. Nothing in
 * this module produces an amount that belongs in `סה"כ הוצאות`, and the band's
 * subtotal is a total of rates rather than a total of spending.
 *
 * Four rules give the reading its shape:
 *
 * - **The rate is worked out, never asked for.** Where the last three recorded
 *   months carry the same figure, that figure is the rate. Where they do not, the
 *   row is `משתנה` and carries the year's monthly average instead — and is never
 *   marked, because a variable row deviating is not news.
 * - **A year is the actual sum of what was recorded**, never a rate multiplied by
 *   twelve. רייזאפ in 2025 was 45 for ten months and 55 for two, and the row reads
 *   its real 560. The earlier year is read over the *same* months as the selected
 *   one, so a partial year is never set against a full one — the rule the trends
 *   screen's `yearOverYear` already follows, and for the same reason.
 * - **A year with nothing recorded is a blank, not a zero** — the ledger's own
 *   rule, one level up. There is no change to state against a year that holds
 *   nothing, so none is invented.
 * - **Every monthly figure divides by the same months the grid does.** The
 *   `Average` comes from `averageOverMonths` over `denominatorMonths`, which is
 *   what the aggregate column inches above this panel is. No figure on this screen
 *   is computed a second way.
 *
 * The band is read at household level whatever tab the grid above is on: a
 * Watched Category is a household line, and a rate paid half by each Person is
 * one rate.
 */

import { type CategoryType, type Categories } from "@/domain/categories/categories";
import { type Ledger, recordedSpan } from "@/domain/ledger/ledger";
import {
  type Average,
  type CategoryGroup,
  HOUSEHOLD_SCOPE,
  averageOverMonths,
  categoryGroups,
  denominatorMonths,
  identifyGroup,
  readGroupMonth,
  yearPeriod,
} from "@/domain/ledger/ledger-analytics";
import { type Currency, type Money, equals, ratio, subtract, sum } from "@/domain/money/money";
import { type CalendarMonth, addMonths, monthRange } from "@/domain/time/calendar-month";

/**
 * How many recorded months must agree before the panel will call a figure a rate.
 *
 * Three, because two is a coincidence: מכבי read 142 twice running in the middle
 * of a climb from 96 to 207, and a panel that had announced 142 as *the rate*
 * would have been announcing the middle of a rise as a settled price. Fewer than
 * three recorded months anywhere in the history is not evidence of a rate either,
 * so a new category reads `משתנה` until it has repeated itself.
 */
export const RATE_EVIDENCE_MONTHS = 3;

/**
 * What makes a year-on-year move worth marking, in the row's own currency. Both
 * bars must be cleared.
 *
 * The grid's own 50% / 1,000₪ bar is calibrated for three hundred cells of
 * ordinary household spending and would miss everything this panel exists to
 * catch: a car insurance renewal at 5,139 → 5,900 is +15% and +761₪ and would not
 * trip it, while these two mark it.
 *
 * The calibration is `rate-watch.test.ts` against the household's real 2024–2026
 * history rather than an assertion in a comment, and what it found is worth
 * stating here, because it looks at first like the bars are set too high: **the
 * pair marks nothing at all in the derived band.** Every fixed-rate subscription
 * the household holds is between 22₪ and 110₪ a month, so none of them can move
 * 300₪ over a year. The two that come closest are the two that show what each bar
 * is for — רייזאפ at 45 → 55 each is +22% and +140₪, which a percentage bar on its
 * own would report as a finding about a twenty-shekel-a-month subscription; and
 * מכבי at +15% and +104₪, whose real story is a climb from 96 to 207 across three
 * years that no single year jumps enough to show, and which is therefore the
 * full-history reading's question rather than this one's.
 */
const RATE_MOVE_RATIO = 0.1;

/** 300₪ over a year, in minor units — 25₪ a month, below which nothing is worth a phone call. */
const RATE_MOVE_MINIMUM = 300_00;

/** Which way a marked row moved. `null` is the ordinary case: it did not move enough. */
export type RateMark = "up" | "down" | null;

/**
 * A row's current rate.
 *
 * `fixed` carries the months that agreed, so the screen can say what the figure
 * rests on rather than asserting it. `variable` carries the selected year's
 * monthly average instead — the same `Average.amount` the year column shows, so
 * the two cannot be two different numbers, and `null` where the year holds
 * nothing to average. An average over no recorded month is undefined and not
 * nought, exactly as the year column beside it is a blank and not a zero.
 */
export type CurrentRate =
  | { readonly kind: "fixed"; readonly amount: Money; readonly months: readonly CalendarMonth[] }
  | { readonly kind: "variable"; readonly average: Money | null };

export interface RateWatchYear {
  readonly year: number;
  /**
   * The months summed and divided by. The selected year's are the grid's own
   * `denominatorMonths`; the earlier year's are those very months a year back,
   * matched one for one — see `rateWatch` for why they are never clamped.
   */
  readonly average: Average;
  /**
   * The actual sum of what was recorded over those months — never a rate times
   * twelve. `null` is *nothing was recorded*, which must render as a blank: a year
   * nobody wrote a figure into is not a year that cost nothing.
   */
  readonly total: Money | null;
}

/**
 * One year against the one before it, or which of three things stopped it being
 * a comparison at all. The same shape as `DeviationBasis` on the trends screen,
 * and for the same reason: a row that cannot be compared is a fact worth printing,
 * and printing it as a number would be inventing one.
 *
 * - `compared` — both years rest on the same months, so the difference is real.
 * - `not-recorded` — the selected year holds nothing for this line.
 * - `first-year` — the earlier year holds nothing. A line recorded for the first
 *   time shows its own figures and no change, rather than a rise from nothing.
 * - `uneven` — both years hold something, over different numbers of recorded
 *   months. 2025's twelve against 2024's six is a difference in how far the
 *   history reaches, and subtracting them would report that as a change in price.
 */
export type RateWatchChange =
  | {
      readonly kind: "compared";
      readonly amount: Money;
      /** `amount ÷ previous`. `null` when the earlier year totalled nought. */
      readonly ratio: number | null;
      readonly mark: RateMark;
    }
  | { readonly kind: "not-recorded" }
  | { readonly kind: "first-year" }
  | { readonly kind: "uneven"; readonly current: number; readonly previous: number };

export interface RateWatchRow {
  readonly key: string;
  readonly name: string;
  readonly type: CategoryType;
  /** Always `null`: a Watched Category is a household line and belongs to no Person. */
  readonly personId: string | null;
  readonly rate: CurrentRate;
  readonly current: RateWatchYear;
  readonly previous: RateWatchYear;
  readonly change: RateWatchChange;
}

export interface RateWatchBand {
  readonly rows: readonly RateWatchRow[];
  /**
   * The rates added up, and nothing else. `משתנה` rows are left out because they
   * have no rate to add, and the count of them is carried so the screen can say
   * how much of itself the subtotal is not covering.
   *
   * This is deliberately not a total of anything on the grid above, and per the
   * plan's load-bearing decision no total is ever printed across two bands.
   */
  readonly subtotal: Money;
  readonly ratedRows: number;
  readonly variableRows: number;
}

export interface RateWatch {
  readonly year: number;
  readonly previousYear: number;
  /**
   * The months each year column covers, matched one for one. Carried on the
   * reading because every column here has to be able to say what it counted: in
   * August 2026 the `2026` column is ינואר–יולי, and a heading that said only
   * "2026" would be claiming a year of evidence for seven months of it.
   */
  readonly currentMonths: readonly CalendarMonth[];
  readonly previousMonths: readonly CalendarMonth[];
  /** חיובים חודשיים — the Watched Categories, read straight off the ledger. */
  readonly monthly: RateWatchBand;
}

/**
 * The panel for one year.
 *
 * `today` and the currency are parameters for the same reason they are on the
 * grid: a function that asks the system for the time cannot be tested against a
 * boundary, and an empty band has no currency of its own for a subtotal to be in.
 */
export function rateWatch(
  ledger: Ledger,
  categories: Categories,
  year: number,
  currency: Currency,
  today: CalendarMonth,
): RateWatch {
  const span = recordedSpan(ledger);

  // The selected year is exactly the span the grid's own aggregate column counts.
  // The earlier year is those very months a year back — matched one for one and
  // never clamped to the ledger, because two sides divided over different numbers
  // of months would report the difference between the spans as a change in price.
  // In August 2026 that is ינואר–יולי against ינואר–יולי, so a subscription does
  // not appear to collapse by five twelfths every January.
  const currentMonths = denominatorMonths(yearPeriod(year), today, span);
  const previousMonths = currentMonths.map((month) => addMonths(month, -12));

  // Every recorded month there is, ascending — what the current rate is read off.
  // The ledger's own span, so the walk is bounded by the history rather than by a
  // window somebody chose.
  const history = span === null ? [] : monthRange(span.first, span.last);

  const watched = new Set(
    categories.household.filter((category) => category.watched).map((category) => category.id),
  );

  const rows = categoryGroups(categories, HOUSEHOLD_SCOPE)
    .filter((group) => watched.has(group.key))
    .map((group) => rowOf(ledger, group, year, currentMonths, previousMonths, history, currency))
    .sort(bySize);

  return {
    year,
    previousYear: year - 1,
    currentMonths,
    previousMonths,
    monthly: bandOf(rows, currency),
  };
}

function rowOf(
  ledger: Ledger,
  group: CategoryGroup,
  year: number,
  currentMonths: readonly CalendarMonth[],
  previousMonths: readonly CalendarMonth[],
  history: readonly CalendarMonth[],
  currency: Currency,
): RateWatchRow {
  const current = yearOf(ledger, group, year, currentMonths, currency);
  const previous = yearOf(ledger, group, year - 1, previousMonths, currency);
  const rate = currentRateOf(ledger, group, history, currency, current);

  return {
    ...identifyGroup(group),
    rate,
    current,
    previous,
    change: changeOf(current, previous, rate),
  };
}

function yearOf(
  ledger: Ledger,
  group: CategoryGroup,
  year: number,
  months: readonly CalendarMonth[],
  currency: Currency,
): RateWatchYear {
  const average = averageOverMonths(ledger, group, months, currency);
  return { year, average, total: average.recordedMonths === 0 ? null : average.total };
}

/**
 * The rate, from the newest recorded months backwards.
 *
 * "Newest" is the newest the *ledger* holds and not the newest of the year being
 * read: `עכשיו` means now, so opening 2024 in 2026 still says what the household
 * is paying today rather than what it was paying then.
 */
function currentRateOf(
  ledger: Ledger,
  group: CategoryGroup,
  history: readonly CalendarMonth[],
  currency: Currency,
  current: RateWatchYear,
): CurrentRate {
  const recent: Money[] = [];
  const months: CalendarMonth[] = [];

  for (let index = history.length - 1; index >= 0 && recent.length < RATE_EVIDENCE_MONTHS; index -= 1) {
    const month = history[index];
    if (month === undefined) continue;
    const reading = readGroupMonth(ledger, group, month, currency);
    if (!reading.recorded) continue;
    recent.push(reading.amount);
    months.push(month);
  }

  // `total` and not `average.amount`: a year nobody recorded anything in averages
  // to a divide-by-twelve zero, and printing that as a rate would be the one thing
  // this reading is not allowed to do.
  const variable = { kind: "variable", average: current.total === null ? null : current.average.amount } as const;

  const newest = recent[0];
  if (newest === undefined || recent.length < RATE_EVIDENCE_MONTHS) return variable;
  if (!recent.every((amount) => equals(amount, newest))) return variable;
  // Collected newest-first; handed back ascending, the way every other month list
  // in the domain reads.
  return { kind: "fixed", amount: newest, months: [...months].reverse() };
}

/**
 * One year against the one before it, or why it is not a comparison.
 *
 * The two sides must rest on the same number of *recorded* months. Both being
 * over the same twelve calendar months is not enough: 2024's history begins in
 * יולי, so 2025's twelve recorded months against 2024's six would report six
 * months of missing history as a doubling in price.
 */
function changeOf(
  current: RateWatchYear,
  previous: RateWatchYear,
  rate: CurrentRate,
): RateWatchChange {
  if (current.total === null) return { kind: "not-recorded" };
  if (previous.total === null) return { kind: "first-year" };

  if (current.average.recordedMonths !== previous.average.recordedMonths) {
    return {
      kind: "uneven",
      current: current.average.recordedMonths,
      previous: previous.average.recordedMonths,
    };
  }

  const amount = subtract(current.total, previous.total);
  const share = ratio(amount, previous.total);
  return { kind: "compared", amount, ratio: share, mark: markOf(amount, share, rate) };
}

/**
 * Both bars, and only on a row that has a rate. A `משתנה` row is never marked:
 * a category that moves every month has not *changed* by moving again, and
 * marking it would fill the panel with the rows it says the least about.
 */
function markOf(amount: Money, share: number | null, rate: CurrentRate): RateMark {
  if (rate.kind === "variable") return null;
  if (share === null || Math.abs(share) < RATE_MOVE_RATIO) return null;
  if (Math.abs(amount.minorUnits) < RATE_MOVE_MINIMUM) return null;
  return amount.minorUnits > 0 ? "up" : "down";
}

function bandOf(rows: readonly RateWatchRow[], currency: Currency): RateWatchBand {
  const rates = rows.flatMap((row) => (row.rate.kind === "fixed" ? [row.rate.amount] : []));
  return {
    rows,
    subtotal: sum(rates, currency),
    ratedRows: rates.length,
    variableRows: rows.length - rates.length,
  };
}

/** Largest current year first, tie-broken on the key so the order is total and stable. */
function bySize(left: RateWatchRow, right: RateWatchRow): number {
  const size = right.current.average.total.minorUnits - left.current.average.total.minorUnits;
  if (size !== 0) return size;
  return left.key < right.key ? -1 : left.key > right.key ? 1 : 0;
}
