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
 *
 * Above it sits the **typed band** — the פריטים שנתיים the ledger cannot supply,
 * out of `annual-items.ts`. It is a different kind of evidence read the same way:
 * one comparison, one pair of bars and one mark, written once here and used by
 * both. The two bands are deliberately **never summed**. One breaks down ledger
 * rows and the other is a detail of ledger rows, so a total across them would be
 * a figure with no meaning; each prints its own subtotal and the screen prints no
 * third.
 */

import {
  type AnnualItem,
  type AnnualItems,
  type Renewal,
  annualItemsByName,
  coversYear,
  latestRenewal,
  renewalsOf,
} from "@/domain/ledger/annual-items";
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
import { type Currency, type Money, divide, equals, ratio, subtract, sum } from "@/domain/money/money";
import { type CalendarDate } from "@/domain/time/calendar-date";
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
 * **Both bands are compared by this one type and this one function.** What a year
 * "rests on" differs — recorded months in the derived band, recorded renewals in
 * the typed one — but the question does not, so there is one implementation of it
 * and not two.
 *
 * - `compared` — both years rest on the same number of records, so the difference
 *   is real.
 * - `not-recorded` — the selected year holds nothing for this line.
 * - `first-year` — the earlier year holds nothing. A line recorded for the first
 *   time shows its own figures and no change, rather than a rise from nothing.
 * - `uneven` — both years hold something, over different numbers of records.
 *   2025's twelve months against 2024's six is a difference in how far the history
 *   reaches, and subtracting them would report that as a change in price; two
 *   renewals in one year against one in the next is the same mistake a year up.
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

/**
 * One band of the panel. Generic over its row because the two bands hold
 * different evidence — a Watched Category's months, an Annual Item's renewals —
 * and identical structure: rows, a subtotal of the rates in them, and how many
 * rows that subtotal does and does not cover.
 */
export interface RateWatchBand<Row> {
  readonly rows: readonly Row[];
  /**
   * The monthly rates added up, and nothing else. Rows with no rate are left out
   * because they have none to add — a `משתנה` category, an item nobody has
   * recorded a price for — and the count of them is carried so the screen can say
   * how much of itself the subtotal is not covering.
   *
   * This is deliberately not a total of anything on the grid above, and per the
   * plan's load-bearing decision **no total is ever printed across two bands**.
   */
  readonly subtotal: Money;
  readonly ratedRows: number;
  readonly unratedRows: number;
}

export interface RateWatch {
  readonly year: number;
  readonly previousYear: number;
  /**
   * The months each year column covers, matched one for one. Carried on the
   * reading because every column here has to be able to say what it counted: in
   * August 2026 the `2026` column is ינואר–יולי, and a heading that said only
   * "2026" would be claiming a year of evidence for seven months of it.
   *
   * The derived band only. A typed year is a whole calendar year, because a
   * renewal is one dated event inside one and there is no partial year of it.
   */
  readonly currentMonths: readonly CalendarMonth[];
  readonly previousMonths: readonly CalendarMonth[];
  /** פריטים שנתיים — the Annual Items, typed by hand. */
  readonly annual: RateWatchBand<RateWatchItemRow>;
  /** חיובים חודשיים — the Watched Categories, read straight off the ledger. */
  readonly monthly: RateWatchBand<RateWatchRow>;
  // There is deliberately no third total here. See `RateWatchBand.subtotal`.
}

// --- the typed band ------------------------------------------------------------

/**
 * An Annual Item's current rate: its newest policy total, and that total over
 * twelve.
 *
 * `never` is an item with no price recorded at all — which is only reachable by
 * removing every renewal, since an item is created with one. It has no rate to
 * state and is not marked; stating nought would be inventing a price.
 */
export type ItemRate =
  | {
      readonly kind: "renewed";
      /** The policy total, whatever number of תשלומים it was billed in. */
      readonly total: Money;
      /** `total ÷ 12` — a reading, computed here and stored nowhere. */
      readonly monthly: Money;
      readonly renewedOn: CalendarDate;
    }
  | { readonly kind: "never" };

/**
 * What one year holds for one Annual Item. Three states, and the distance between
 * them is the point:
 *
 * - `renewed` — one or more renewals fell in that year, and the figure is their
 *   sum. Two of them is a real state: a policy that slipped from December to
 *   January leaves one year holding both, which is why the count travels with the
 *   total and why the comparison refuses two against one.
 * - `not-renewed` — the item was alive that year and no renewal was recorded in
 *   it. `לא חודש`, never `0`: the ledger's blank-is-not-zero rule, one level up.
 * - `outside` — the year is before the item's price history begins (or after it
 *   ended). Nothing was missed, because there was nothing there yet.
 */
export type ItemYearReading =
  | { readonly kind: "renewed"; readonly total: Money; readonly renewals: number }
  | { readonly kind: "not-renewed" }
  | { readonly kind: "outside" };

export interface RateWatchItemYear {
  readonly year: number;
  readonly reading: ItemYearReading;
}

export interface RateWatchItemRow {
  readonly key: string;
  readonly name: string;
  readonly rate: ItemRate;
  readonly current: RateWatchItemYear;
  readonly previous: RateWatchItemYear;
  /** The very same comparison the derived band's rows carry. */
  readonly change: RateWatchChange;
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
  items: AnnualItems,
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

  const typed = annualItemsByName(items)
    .map((item) => itemRowOf(items, item, year))
    .sort(byPrice);

  return {
    year,
    previousYear: year - 1,
    currentMonths,
    previousMonths,
    annual: bandOf(typed, (row) => (row.rate.kind === "renewed" ? row.rate.monthly : null), currency),
    monthly: bandOf(rows, (row) => (row.rate.kind === "fixed" ? row.rate.amount : null), currency),
  };
}

// --- one Annual Item ------------------------------------------------------------

/**
 * One typed row: what the item costs now, the two years, and the change between
 * them — through the same `changeOf` the derived band goes through.
 *
 * The rate is the *newest* renewal wherever the panel's year is set, for the same
 * reason `עכשיו` means now in the band below: opening 2024 in 2026 must still say
 * what the household is paying today.
 */
function itemRowOf(items: AnnualItems, item: AnnualItem, year: number): RateWatchItemRow {
  const history = renewalsOf(items, item.id);
  const newest = latestRenewal(items, item.id);
  const rate: ItemRate =
    newest === undefined
      ? { kind: "never" }
      : {
          kind: "renewed",
          total: newest.amount,
          // The policy total over twelve. A reading on the way to the screen, and
          // the only place this division happens.
          monthly: divide(newest.amount, 12),
          renewedOn: newest.renewedOn,
        };

  const current = itemYearOf(item, history, year);
  const previous = itemYearOf(item, history, year - 1);

  return {
    key: item.id,
    name: item.name,
    rate,
    current,
    previous,
    change: changeOf(comparableItemYear(current), comparableItemYear(previous), rate.kind === "renewed"),
  };
}

/**
 * One year of one item. The year is derived from each renewal's date and stored
 * nowhere, so a September renewal cannot be filed under the wrong year by hand.
 */
function itemYearOf(
  item: AnnualItem,
  history: readonly Renewal[],
  year: number,
): RateWatchItemYear {
  if (!coversYear(item, year)) return { year, reading: { kind: "outside" } };

  const inYear = history.filter((renewal) => renewal.renewedOn.year === year);
  const first = inYear[0];
  if (first === undefined) return { year, reading: { kind: "not-renewed" } };

  return {
    year,
    reading: {
      kind: "renewed",
      total: sum(inYear.map((renewal) => renewal.amount), first.amount.currency),
      renewals: inYear.length,
    },
  };
}

/**
 * A typed year as the comparison sees it. `לא חודש` and *outside its life* are
 * both "nothing to compare" here — they differ on screen, where the distance
 * between them is what a reader needs, and not in the arithmetic, which has
 * nothing either way.
 */
function comparableItemYear(year: RateWatchItemYear): Comparable {
  const { reading } = year;
  return reading.kind === "renewed"
    ? { total: reading.total, records: reading.renewals }
    : { total: null, records: 0 };
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
    change: changeOf(comparableYear(current), comparableYear(previous), rate.kind === "fixed"),
  };
}

/**
 * A derived year as the comparison sees it: what it totalled, and how many
 * *recorded* months that total rests on.
 */
function comparableYear(year: RateWatchYear): Comparable {
  return { total: year.total, records: year.average.recordedMonths };
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
 * A year reduced to what a comparison needs: what it totalled, and how many
 * records that total rests on. Recorded months in one band, recorded renewals in
 * the other — the arithmetic below cannot tell, and must not need to.
 */
interface Comparable {
  readonly total: Money | null;
  readonly records: number;
}

/**
 * One year against the one before it, or why it is not a comparison. **One
 * implementation, used by both bands.**
 *
 * The two sides must rest on the same number of records. Both covering the same
 * twelve calendar months is not enough: 2024's history begins in יולי, so 2025's
 * twelve recorded months against 2024's six would report six months of missing
 * history as a doubling in price — and a year holding two renewals against one
 * holding a single renewal is that same mistake told annually.
 */
function changeOf(current: Comparable, previous: Comparable, rated: boolean): RateWatchChange {
  if (current.total === null) return { kind: "not-recorded" };
  if (previous.total === null) return { kind: "first-year" };

  if (current.records !== previous.records) {
    return { kind: "uneven", current: current.records, previous: previous.records };
  }

  const amount = subtract(current.total, previous.total);
  const share = ratio(amount, previous.total);
  return { kind: "compared", amount, ratio: share, mark: markOf(amount, share, rated) };
}

/**
 * Both bars, and only on a row that has a rate. A `משתנה` row is never marked:
 * a category that moves every month has not *changed* by moving again, and
 * marking it would fill the panel with the rows it says the least about. In the
 * typed band the same rule reads as *an item with no recorded price is not
 * marked*, which is the same statement about the same absence.
 */
function markOf(amount: Money, share: number | null, rated: boolean): RateMark {
  if (!rated) return null;
  if (share === null || Math.abs(share) < RATE_MOVE_RATIO) return null;
  if (Math.abs(amount.minorUnits) < RATE_MOVE_MINIMUM) return null;
  return amount.minorUnits > 0 ? "up" : "down";
}

/**
 * A band from its rows. `rateOf` is what each kind of row calls a monthly rate —
 * a category's agreed figure, an item's policy total over twelve — and `null`
 * where the row has none to add.
 */
function bandOf<Row>(
  rows: readonly Row[],
  rateOf: (row: Row) => Money | null,
  currency: Currency,
): RateWatchBand<Row> {
  const rates = rows.flatMap((row) => {
    const rate = rateOf(row);
    return rate === null ? [] : [rate];
  });
  return {
    rows,
    subtotal: sum(rates, currency),
    ratedRows: rates.length,
    unratedRows: rows.length - rates.length,
  };
}

/** Largest current year first, tie-broken on the key so the order is total and stable. */
function bySize(left: RateWatchRow, right: RateWatchRow): number {
  const size = right.current.average.total.minorUnits - left.current.average.total.minorUnits;
  if (size !== 0) return size;
  return left.key < right.key ? -1 : left.key > right.key ? 1 : 0;
}

/**
 * Most expensive policy first. The typed band is ordered by what each item costs
 * *now* rather than by the selected year, because an annual bill is routinely not
 * renewed yet in the year being read — ordering on that would shuffle the band
 * every January and put the largest bill in the household at the bottom of it.
 * Alphabetical underneath, so the order is total and stable.
 */
function byPrice(left: RateWatchItemRow, right: RateWatchItemRow): number {
  const priceOf = (row: RateWatchItemRow) => (row.rate.kind === "renewed" ? row.rate.total.minorUnits : 0);
  const size = priceOf(right) - priceOf(left);
  return size === 0 ? left.name.localeCompare(right.name, "he") : size;
}
