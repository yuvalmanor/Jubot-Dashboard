/**
 * RsuPosition (מחשבון RSU) — the position, its lots, and each lot's own סעיף 102
 * clock.
 *
 * Framework-free per ADR 0004.
 *
 * A **Grant** is what the paperwork awarded: an ID, a date, a number of shares. A
 * **Vest** is a slice of it actually becoming the household's, on a date, at a
 * price. A **Sale** is shares leaving one named vest. A vest with shares still in
 * it is a **Lot**, and a lot is the unit everything here is answered in, because a
 * lot is the unit tax is answered in.
 *
 * Three rules give it its shape:
 *
 * **Qualification is derived, never stored.** A lot is Qualified when סעיף 102's
 * twenty-four months from its *grant* date have run. There is no flag to go stale:
 * the same lot read on two days gives two answers, which is the correct behaviour
 * for a fact whose only input is the passage of time. A stored flag would have to
 * be swept by something, and whatever failed to run would price an early sale as
 * though the clock had finished.
 *
 * **A future vest is not a position.** Vests are recorded ahead of time so the
 * forecast has something to work with, and they are held out of the position until
 * their date arrives. Shares nobody has yet cannot be sold and are not exposed to
 * anything.
 *
 * **A sale names its lot.** Which lot shares left decides how they are taxed, so
 * "sold 19 shares" is not a record of anything — it is a question. A sale reduces
 * the lot it names and no other, and one that would take more than the lot holds is
 * refused rather than allowed to leave a negative position.
 *
 * GP — the grant price סעיף 102's Qualified path taxes as ordinary income — is
 * either **stated** off an ESOP document, which is a fact, or **estimated** from
 * closes over a window, which is not. The two are different things and this module
 * refuses to let them read alike: an estimate carries the window that produced it,
 * so nothing downstream can print it as though somebody had measured it. The window
 * itself is a household setting rather than a constant here, because which window
 * סעיף 102 actually means is the open question this whole area waits on.
 */

import {
  type Currency,
  type Money,
  fromScaledInteger,
  money,
  sum,
  toScaledInteger,
  zero,
} from "@/domain/money/money";
import {
  type CalendarDate,
  addDays,
  addMonths,
  compareDates,
  dateKey,
  parseDateKey,
} from "@/domain/time/calendar-date";

// --- a price per share -------------------------------------------------------

/**
 * How many decimal places a share price carries. Four, because the household's own
 * GP figures have four — 149.4219 — and a price rounded to the cent would quietly
 * change the tax on every share it multiplies.
 */
export const PRICE_DIGITS = 4;

/**
 * A price per share. Not a `Money`: an amount of money is a number of agorot or
 * cents, and a price is a rate between money and shares — the same distinction
 * that keeps `ExchangeRate` out of `Money`. Held as an exact integer count of
 * ten-thousandths so nothing here is ever a float: $149.4219 is 1,494,219.
 */
export interface SharePrice {
  readonly tenThousandths: number;
  readonly currency: Currency;
}

export class InvalidSharePriceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidSharePriceError";
  }
}

export function sharePrice(tenThousandths: number, currency: Currency): SharePrice {
  if (!Number.isSafeInteger(tenThousandths)) {
    throw new InvalidSharePriceError(
      `A price is an integer number of ten-thousandths, received ${String(tenThousandths)}`,
    );
  }
  if (tenThousandths < 0) {
    throw new InvalidSharePriceError("A share price cannot be negative");
  }
  return { tenThousandths, currency };
}

/** Build from major units — `280`, `"149.4219"`. Extra precision rounds to the ten-thousandth. */
export function sharePriceFromMajorUnits(value: number | string, currency: Currency): SharePrice {
  return sharePrice(toScaledInteger(value, PRICE_DIGITS), currency);
}

/**
 * Read what a person typed. Blank is `null` and not zero — an empty field is a
 * price nobody stated, and a share is not worth nothing because nobody said.
 */
export function parseSharePriceInput(text: string, currency: Currency): SharePrice | null {
  const stripped = text
    .replace(/[‎‏؜]/g, "")
    .replace(/[\s  ,']/g, "")
    .replace(/[₪$]/g, "");
  if (stripped.length === 0) return null;

  if (!/^\d+(\.\d+)?$/.test(stripped)) {
    throw new InvalidSharePriceError(`Expected a price per share, received ${JSON.stringify(text)}`);
  }
  return sharePriceFromMajorUnits(stripped, currency);
}

/** The exact decimal — `149.4219`. Round-trips through `parseSharePriceInput` unchanged. */
export function sharePriceToDecimalString(price: SharePrice): string {
  return fromScaledInteger(price.tenThousandths, PRICE_DIGITS);
}

/** Hebrew locale, four places, so two prices line up in a column. */
export function formatSharePrice(price: SharePrice, locale = "he-IL"): string {
  return new Intl.NumberFormat(locale, {
    style: "currency",
    currency: price.currency,
    minimumFractionDigits: PRICE_DIGITS,
    maximumFractionDigits: PRICE_DIGITS,
  }).format(price.tenThousandths / 10 ** PRICE_DIGITS);
}

export function sharePricesEqual(left: SharePrice, right: SharePrice): boolean {
  return left.currency === right.currency && left.tenThousandths === right.tenThousandths;
}

/** Round half away from zero, on exact integers. Prices are fine-grained; doubles are not. */
function divideRounded(numerator: bigint, denominator: bigint): bigint {
  if (denominator <= 0n) {
    throw new InvalidSharePriceError("Denominator must be positive");
  }
  const negative = numerator < 0n;
  const magnitude = negative ? -numerator : numerator;
  const quotient = magnitude / denominator;
  const rounded = (magnitude % denominator) * 2n >= denominator ? quotient + 1n : quotient;
  return negative ? -rounded : rounded;
}

/**
 * A price times a whole number of shares, as money. The product is exact in
 * ten-thousandths and rounded to the cent once, at the end — rounding the price
 * first and multiplying after would put the error in every share.
 */
export function valueOf(price: SharePrice, shares: number): Money {
  if (!Number.isSafeInteger(shares) || shares < 0) {
    throw new InvalidSharePriceError(`Shares are a whole count, received ${String(shares)}`);
  }
  const scaled = BigInt(price.tenThousandths) * BigInt(shares);
  return money(
    Number(divideRounded(scaled * 100n, 10n ** BigInt(PRICE_DIGITS))),
    price.currency,
  );
}

/** The mean of a set of prices, exact to the ten-thousandth. `null` over nothing. */
export function averagePrice(prices: readonly SharePrice[]): SharePrice | null {
  const first = prices[0];
  if (first === undefined) return null;

  let total = 0n;
  for (const price of prices) {
    if (price.currency !== first.currency) {
      throw new InvalidSharePriceError(
        `Cannot average a ${first.currency} price with a ${price.currency} one`,
      );
    }
    total += BigInt(price.tenThousandths);
  }
  return sharePrice(Number(divideRounded(total, BigInt(prices.length))), first.currency);
}

// --- the GP window -----------------------------------------------------------

/**
 * What "the days around the grant" counts. `calendar` counts days off the
 * calendar, which is what the household's sheet does. `trading` counts sessions —
 * days the market actually closed — which is what סעיף 102 is generally applied
 * as, and the two are not the same span.
 */
export type GpWindowBasis = "calendar" | "trading";

export const GP_WINDOW_BASES: readonly GpWindowBasis[] = ["calendar", "trading"];

export function isGpWindowBasis(value: unknown): value is GpWindowBasis {
  return typeof value === "string" && (GP_WINDOW_BASES as string[]).includes(value);
}

/**
 * The span of closes a GP estimate averages, relative to the grant date. Both
 * candidate rules are this one shape with different numbers in it, which is the
 * point: the household can correct the window without anybody touching code.
 *
 * The grant's own day is a field of its own rather than an off-by-one hidden
 * inside `after`, because the two rules disagree about it and a window nobody can
 * read off the screen is a window nobody can check.
 */
export interface GpWindow {
  readonly basis: GpWindowBasis;
  /** Days or sessions strictly before the grant date. */
  readonly before: number;
  /** Days or sessions strictly after it. */
  readonly after: number;
  /** Whether the grant's own day counts. סעיף 102 looks only at what came before. */
  readonly includesGrantDay: boolean;
}

export class InvalidGpWindowError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidGpWindowError";
  }
}

export function buildGpWindow(window: GpWindow): GpWindow {
  for (const [what, value] of [
    ["before", window.before],
    ["after", window.after],
  ] as const) {
    if (!Number.isInteger(value) || value < 0 || value > 365) {
      throw new InvalidGpWindowError(
        `A GP window's ${what} is a whole number of days between 0 and 365, received ${String(value)}`,
      );
    }
  }
  if (!isGpWindowBasis(window.basis)) {
    throw new InvalidGpWindowError(`Unknown GP window basis ${String(window.basis)}`);
  }
  if (window.before === 0 && window.after === 0 && !window.includesGrantDay) {
    throw new InvalidGpWindowError("A GP window spanning no days at all averages nothing");
  }
  return {
    basis: window.basis,
    before: window.before,
    after: window.after,
    includesGrantDay: window.includesGrantDay === true,
  };
}

/**
 * The window סעיף 102 is generally applied as: the thirty trading days *preceding*
 * the grant, the grant's own day not among them.
 */
export const SECTION_102_WINDOW: GpWindow = {
  basis: "trading",
  before: 30,
  after: 0,
  includesGrantDay: false,
};

/** What the household's sheet does: calendar closes from grant −15 days to +15, the grant day among them. */
export const SHEET_WINDOW: GpWindow = {
  basis: "calendar",
  before: 15,
  after: 15,
  includesGrantDay: true,
};

/**
 * Where the system starts. It is the סעיף 102 reading, and it is a *setting* —
 * which window the section actually means is the open question this area waits on,
 * and a household that confirms otherwise against an ESOP statement changes it
 * without a deploy.
 */
export const DEFAULT_GP_WINDOW: GpWindow = SECTION_102_WINDOW;

/** `trading:30:0:excl` — how a window is stored and how one is named on screen. */
export function gpWindowKey(window: GpWindow): string {
  return `${window.basis}:${window.before}:${window.after}:${window.includesGrantDay ? "incl" : "excl"}`;
}

export function parseGpWindow(text: string): GpWindow {
  const parts = text.trim().split(":");
  if (parts.length !== 4) {
    throw new InvalidGpWindowError(
      `Expected a window of the form basis:before:after:incl, received ${JSON.stringify(text)}`,
    );
  }
  const [basis = "", before = "", after = "", grantDay = ""] = parts;
  if (grantDay !== "incl" && grantDay !== "excl") {
    throw new InvalidGpWindowError(`A window says incl or excl of the grant day, received ${JSON.stringify(grantDay)}`);
  }
  return buildGpWindow({
    basis: basis as GpWindowBasis,
    before: Number(before),
    after: Number(after),
    includesGrantDay: grantDay === "incl",
  });
}

export function gpWindowsEqual(left: GpWindow, right: GpWindow): boolean {
  return gpWindowKey(left) === gpWindowKey(right);
}

// --- what a grant price is, and where it came from ---------------------------

/**
 * `stated` — read off an ESOP document. A fact.
 * `estimated` — averaged out of closes over a window. Not a fact, and it says so
 * everywhere it is displayed.
 */
export type GrantPriceSource = "stated" | "estimated";

export interface GrantPrice {
  readonly price: SharePrice;
  readonly source: GrantPriceSource;
  /**
   * The window the estimate was taken over, and `null` for a stated price, which no
   * window produced. Carried on the figure rather than looked up later: the setting
   * can move, and an estimate taken under the old one was still taken under the old
   * one.
   */
  readonly window: GpWindow | null;
  /** How many closes went into the average. `null` for a stated price. */
  readonly sampleCount: number | null;
}

export function statedGrantPrice(price: SharePrice): GrantPrice {
  return { price, source: "stated", window: null, sampleCount: null };
}

export function isEstimated(grantPrice: GrantPrice): boolean {
  return grantPrice.source === "estimated";
}

/**
 * Whether an estimate was taken under a window the household has since changed.
 * A stated price is never stale — nothing about it depends on the window.
 */
export function isStaleEstimate(grantPrice: GrantPrice, current: GpWindow): boolean {
  return grantPrice.window !== null && !gpWindowsEqual(grantPrice.window, current);
}

/** One day's closing price. A close exists only on a day the market traded. */
export interface DailyClose {
  readonly on: CalendarDate;
  readonly close: SharePrice;
}

export class InvalidDailyCloseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidDailyCloseError";
  }
}

/**
 * Read closes as they are pasted out of a market-data page: one line per session,
 * a date and a close, separated by whatever the source put between them.
 *
 * Blank lines are skipped and a line that is not a date and a price is refused
 * rather than dropped — a sample quietly missing three sessions is an average
 * nobody can check. Two closes for one day are refused for the same reason: which
 * of them is the close is not a question this can answer by picking one.
 */
export function parseDailyCloses(text: string, currency: Currency): readonly DailyClose[] {
  const closes: DailyClose[] = [];
  const seen = new Set<string>();

  for (const [index, line] of text.split(/\r?\n/).entries()) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;

    const match = /^(\d{4}-\d{2}-\d{2})[\s,;\t]+(.+)$/.exec(trimmed);
    if (match === null) {
      throw new InvalidDailyCloseError(
        `Line ${index + 1} is not a date and a close: ${JSON.stringify(trimmed)}`,
      );
    }

    const [, on = "", close = ""] = match;
    const price = parseSharePriceInput(close, currency);
    if (price === null) {
      throw new InvalidDailyCloseError(`Line ${index + 1} states a date with no close beside it`);
    }
    if (seen.has(on)) {
      throw new InvalidDailyCloseError(`${on} appears twice; a day has one close`);
    }
    seen.add(on);

    closes.push({ on: parseDateKey(on), close: price });
  }

  return closes;
}

/**
 * The closes a window selects, oldest first.
 *
 * On the `trading` basis the list of closes *is* the trading calendar — a session
 * is a day there is a close for — so "the thirty trading days preceding" is the
 * thirty latest closes before the grant date, however many weekends and holidays
 * that spans. On the `calendar` basis the span is measured in days and whichever
 * closes fall inside it are the sample, which is what the sheet does.
 */
export function closesInWindow(
  closes: readonly DailyClose[],
  grantedOn: CalendarDate,
  window: GpWindow,
): readonly DailyClose[] {
  const ordered = [...closes].sort((left, right) => compareDates(left.on, right.on));
  const onGrantDay = window.includesGrantDay
    ? ordered.filter((close) => compareDates(close.on, grantedOn) === 0)
    : [];

  if (window.basis === "calendar") {
    const from = addDays(grantedOn, -window.before);
    const to = addDays(grantedOn, window.after);
    return ordered.filter((close) => {
      if (compareDates(close.on, grantedOn) === 0) return window.includesGrantDay;
      if (compareDates(close.on, grantedOn) < 0) {
        return window.before > 0 && compareDates(close.on, from) >= 0;
      }
      return window.after > 0 && compareDates(close.on, to) <= 0;
    });
  }

  // On the trading basis the closes themselves are the calendar: a session is a
  // day there is a close for, so "the thirty preceding" is a count of rows and
  // not a span of dates.
  const before = ordered.filter((close) => compareDates(close.on, grantedOn) < 0).slice(-window.before);
  const after = ordered.filter((close) => compareDates(close.on, grantedOn) > 0).slice(0, window.after);
  return [...(window.before > 0 ? before : []), ...onGrantDay, ...after];
}

/**
 * GP estimated from market data over the window. `null` when no close falls inside
 * it: an average over nothing is not an estimate, and a grant with no figure is a
 * better state than a grant with an invented one.
 */
export function estimateGrantPrice(input: {
  readonly closes: readonly DailyClose[];
  readonly grantedOn: CalendarDate;
  readonly window: GpWindow;
}): GrantPrice | null {
  const window = buildGpWindow(input.window);
  const sample = closesInWindow(input.closes, input.grantedOn, window);
  const average = averagePrice(sample.map((close) => close.close));
  if (average === null) return null;

  return { price: average, source: "estimated", window, sampleCount: sample.length };
}

// --- grants ------------------------------------------------------------------

/**
 * What the paperwork awarded. `reference` is the ID the grant document states,
 * kept as written and left in English the way `RSU` and `ACWI` are.
 */
export interface Grant {
  readonly id: string;
  readonly personId: string;
  readonly reference: string;
  readonly grantedOn: CalendarDate;
  readonly totalShares: number;
  /** GP, or `null` while nobody has stated or estimated one. */
  readonly grantPrice: GrantPrice | null;
}

export class InvalidGrantError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidGrantError";
  }
}

export class UnknownGrantError extends Error {
  constructor(readonly grantId: string) {
    super(`No such grant: ${grantId}`);
    this.name = "UnknownGrantError";
  }
}

function normalise(value: string): string {
  return value.trim().replace(/\s+/g, " ");
}

function requireText(value: string, what: string, limit: number, fail: (message: string) => Error): string {
  const normalised = normalise(value);
  if (normalised.length === 0) throw fail(`${what} cannot be empty`);
  if (normalised.length > limit) {
    throw fail(`${what} cannot exceed ${limit} characters, received ${normalised.length}`);
  }
  return normalised;
}

function requireShares(value: number, what: string, fail: (message: string) => Error): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw fail(`${what} is a whole number of shares greater than zero, received ${String(value)}`);
  }
  return value;
}

export interface GrantDefinition {
  readonly personId: string;
  readonly reference: string;
  readonly grantedOn: CalendarDate;
  readonly totalShares: number;
  readonly grantPrice?: GrantPrice | null;
}

const grantFailure = (message: string) => new InvalidGrantError(message);

export function buildGrant(id: string, definition: GrantDefinition): Grant {
  return {
    id,
    personId: definition.personId,
    reference: requireText(definition.reference, "A grant ID", 40, grantFailure),
    grantedOn: definition.grantedOn,
    totalShares: requireShares(definition.totalShares, "A grant", grantFailure),
    grantPrice: definition.grantPrice ?? null,
  };
}

export function findGrant(grants: readonly Grant[], id: string): Grant | undefined {
  return grants.find((grant) => grant.id === id);
}

export function requireGrant(grants: readonly Grant[], id: string): Grant {
  const grant = findGrant(grants, id);
  if (grant === undefined) throw new UnknownGrantError(id);
  return grant;
}

/** Grants oldest first — the order they were awarded. */
export function grantsInReadingOrder(grants: readonly Grant[]): readonly Grant[] {
  return [...grants].sort(
    (left, right) =>
      compareDates(left.grantedOn, right.grantedOn) ||
      left.reference.localeCompare(right.reference, "en") ||
      left.id.localeCompare(right.id),
  );
}

// --- the 24-month clock ------------------------------------------------------

/** סעיף 102's holding period, in months. Counted in months because that is what the section says. */
export const QUALIFYING_MONTHS = 24;

/**
 * The day a grant's shares become Qualified: twenty-four months after the grant
 * date. Derived on every read from the one input it has, so the boundary moves
 * correctly as time passes and there is no flag anywhere to go stale.
 */
export function qualifiesOn(grantedOn: CalendarDate): CalendarDate {
  return addMonths(grantedOn, QUALIFYING_MONTHS);
}

/**
 * Whether the period has run by a date. The qualifying day itself counts as
 * Qualified — twenty-four months have passed on the day they have passed.
 */
export function isQualifiedOn(grantedOn: CalendarDate, asOf: CalendarDate): boolean {
  return compareDates(asOf, qualifiesOn(grantedOn)) >= 0;
}

// --- vests -------------------------------------------------------------------

/**
 * A slice of a grant actually becoming the household's. Recorded ahead of its date
 * as readily as after it: a vest in November is a fact about November whether it is
 * September or December when it is typed in.
 */
export interface Vest {
  readonly id: string;
  readonly grantId: string;
  readonly vestedOn: CalendarDate;
  readonly shares: number;
  /** What a share was worth on the day it vested. */
  readonly priceAtVest: SharePrice;
}

export class InvalidVestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidVestError";
  }
}

export class UnknownVestError extends Error {
  constructor(readonly vestId: string) {
    super(`No such vest: ${vestId}`);
    this.name = "UnknownVestError";
  }
}

/**
 * More shares vesting out of a grant than the grant ever awarded. Refused: the two
 * figures come off the same document, and a position built on the contradiction
 * would overstate what the household holds.
 */
export class GrantOversubscribedError extends Error {
  constructor(
    readonly grantId: string,
    readonly totalShares: number,
    readonly vestedShares: number,
  ) {
    super(
      `Grant ${grantId} awarded ${totalShares} shares and its vests already claim ${vestedShares}`,
    );
    this.name = "GrantOversubscribedError";
  }
}

export interface VestDefinition {
  readonly grantId: string;
  readonly vestedOn: CalendarDate;
  readonly shares: number;
  readonly priceAtVest: SharePrice;
}

const vestFailure = (message: string) => new InvalidVestError(message);

export function buildVest(id: string, definition: VestDefinition, grant: Grant): Vest {
  if (definition.grantId !== grant.id) {
    throw vestFailure(`This vest belongs to grant ${definition.grantId}, not to ${grant.id}`);
  }
  if (compareDates(definition.vestedOn, grant.grantedOn) < 0) {
    throw vestFailure(
      `A vest on ${dateKey(definition.vestedOn)} precedes its grant on ${dateKey(grant.grantedOn)}`,
    );
  }

  return {
    id,
    grantId: grant.id,
    vestedOn: definition.vestedOn,
    shares: requireShares(definition.shares, "A vest", vestFailure),
    priceAtVest: definition.priceAtVest,
  };
}

export function vestsOf(vests: readonly Vest[], grantId: string): readonly Vest[] {
  return vests
    .filter((vest) => vest.grantId === grantId)
    .sort((left, right) => compareDates(left.vestedOn, right.vestedOn) || left.id.localeCompare(right.id));
}

export function findVest(vests: readonly Vest[], id: string): Vest | undefined {
  return vests.find((vest) => vest.id === id);
}

export function requireVest(vests: readonly Vest[], id: string): Vest {
  const vest = findVest(vests, id);
  if (vest === undefined) throw new UnknownVestError(id);
  return vest;
}

/**
 * Whether one more vest fits inside what the grant awarded. Checked before it is
 * written, so the contradictory state never exists.
 */
export function requireWithinGrant(input: {
  readonly grant: Grant;
  readonly vests: readonly Vest[];
  readonly additionalShares: number;
  /** A vest being corrected rather than added — its own shares do not count twice. */
  readonly replacingVestId?: string | null;
}): void {
  const replacing = input.replacingVestId ?? null;
  const existing = vestsOf(input.vests, input.grant.id)
    .filter((vest) => vest.id !== replacing)
    .reduce((running, vest) => running + vest.shares, 0);

  const claimed = existing + input.additionalShares;
  if (claimed > input.grant.totalShares) {
    throw new GrantOversubscribedError(input.grant.id, input.grant.totalShares, claimed);
  }
}

// --- sales -------------------------------------------------------------------

/**
 * Shares leaving one named lot. The lot is not a detail: which one they left is
 * what decides how they are taxed, so a sale that did not name one would be a
 * question rather than a record.
 */
export interface Sale {
  readonly id: string;
  readonly vestId: string;
  readonly soldOn: CalendarDate;
  readonly shares: number;
  readonly price: SharePrice;
}

export class InvalidSaleError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidSaleError";
  }
}

/** A sale that would take more shares than the lot holds. Refused, never clamped. */
export class LotOversoldError extends Error {
  constructor(
    readonly vestId: string,
    readonly remaining: number,
    readonly attempted: number,
  ) {
    super(
      `Lot ${vestId} holds ${remaining} shares and the sale claims ${attempted}; ` +
        "a lot cannot go below nothing",
    );
    this.name = "LotOversoldError";
  }
}

export interface SaleDefinition {
  readonly vestId: string;
  readonly soldOn: CalendarDate;
  readonly shares: number;
  readonly price: SharePrice;
}

const saleFailure = (message: string) => new InvalidSaleError(message);

export function buildSale(id: string, definition: SaleDefinition, vest: Vest): Sale {
  if (definition.vestId !== vest.id) {
    throw saleFailure(`This sale belongs to lot ${definition.vestId}, not to ${vest.id}`);
  }
  if (compareDates(definition.soldOn, vest.vestedOn) < 0) {
    throw saleFailure(
      `A sale on ${dateKey(definition.soldOn)} precedes the vest it sells, on ${dateKey(vest.vestedOn)}`,
    );
  }

  return {
    id,
    vestId: vest.id,
    soldOn: definition.soldOn,
    shares: requireShares(definition.shares, "A sale", saleFailure),
    price: definition.price,
  };
}

/** One lot's sales, oldest first. */
export function salesOf(sales: readonly Sale[], vestId: string): readonly Sale[] {
  return sales
    .filter((sale) => sale.vestId === vestId)
    .sort((left, right) => compareDates(left.soldOn, right.soldOn) || left.id.localeCompare(right.id));
}

/**
 * Whether one more sale fits in the lot. Run before the insert, the same way an
 * overdrawing project expense is refused before it is written.
 */
export function requireWithinLot(input: {
  readonly vest: Vest;
  readonly sales: readonly Sale[];
  readonly additionalShares: number;
}): void {
  const sold = salesOf(input.sales, input.vest.id).reduce((running, sale) => running + sale.shares, 0);
  const remaining = input.vest.shares - sold;

  if (input.additionalShares > remaining) {
    throw new LotOversoldError(input.vest.id, remaining, input.additionalShares);
  }
}

// --- lots --------------------------------------------------------------------

/**
 * A vest read as a holding: what is left in it, and where it stands against its own
 * clock. Every field but the vest and the grant is derived on this read, so a lot
 * carries no state that could disagree with the rows it came from.
 */
export interface Lot {
  readonly vest: Vest;
  readonly grant: Grant;
  readonly soldShares: number;
  readonly remainingShares: number;
  /** The day this lot's shares become Qualified — its grant date plus 24 months. */
  readonly qualifiedFrom: CalendarDate;
  /** Whether that day has come, as of the date the position was read at. */
  readonly qualified: boolean;
  /** What the shares still in it were worth on the day they vested. */
  readonly remainingValueAtVest: Money;
}

function lotFrom(vest: Vest, grant: Grant, sales: readonly Sale[], asOf: CalendarDate): Lot {
  const soldShares = salesOf(sales, vest.id)
    .filter((sale) => compareDates(sale.soldOn, asOf) <= 0)
    .reduce((running, sale) => running + sale.shares, 0);
  const remainingShares = vest.shares - soldShares;

  return {
    vest,
    grant,
    soldShares,
    remainingShares,
    qualifiedFrom: qualifiesOn(grant.grantedOn),
    qualified: isQualifiedOn(grant.grantedOn, asOf),
    remainingValueAtVest: valueOf(vest.priceAtVest, Math.max(remainingShares, 0)),
  };
}

// --- the position ------------------------------------------------------------

/** A vest whose date has not arrived. Recorded, and deliberately not a holding. */
export interface FutureVest {
  readonly vest: Vest;
  readonly grant: Grant;
  readonly qualifiedFrom: CalendarDate;
}

/**
 * One grant held against its own paperwork, so the arithmetic between the document
 * and the vest rows is visible rather than assumed.
 */
export interface GrantReading {
  readonly grant: Grant;
  readonly totalShares: number;
  /** Σ of every recorded vest, whether or not its date has come. */
  readonly scheduledShares: number;
  /** Awarded but with no vest row recorded against it yet. */
  readonly unscheduledShares: number;
  readonly vestedShares: number;
  readonly remainingShares: number;
}

/**
 * The position as of a day: every lot that has vested by then, split by its own
 * clock, with the vests still ahead held out of it.
 *
 * `asOf` is a parameter and never read from a system clock inside — a function
 * that asks the world what day it is cannot be tested on the day either side of a
 * boundary, and the boundary is the whole point.
 */
export interface RsuPosition {
  readonly asOf: CalendarDate;
  /** Every lot vested by `asOf`, oldest first. Includes lots sold down to nothing. */
  readonly lots: readonly Lot[];
  /** Shares held whose 24 months have run — taxed at the capital-gains rate. */
  readonly qualifiedShares: number;
  /** Shares held still inside the window — exposed to the 62.17% rate. */
  readonly unqualifiedShares: number;
  /** `qualified + unqualified` — everything actually held. */
  readonly remainingShares: number;
  readonly soldShares: number;
  /** What the held shares were worth on their own vesting days. */
  readonly qualifiedValueAtVest: Money;
  readonly unqualifiedValueAtVest: Money;
  /** Vests recorded ahead of their date, excluded from every figure above. */
  readonly future: readonly FutureVest[];
  readonly futureShares: number;
  readonly grants: readonly GrantReading[];
}

export function readPosition(input: {
  readonly grants: readonly Grant[];
  readonly vests: readonly Vest[];
  readonly sales: readonly Sale[];
  readonly asOf: CalendarDate;
  /** The currency the position is denominated in. Apple RSU is a dollar holding. */
  readonly currency?: Currency;
}): RsuPosition {
  const { asOf } = input;
  const currency = input.currency ?? "USD";
  const ordered = grantsInReadingOrder(input.grants);

  const lots: Lot[] = [];
  const future: FutureVest[] = [];
  const grantReadings: GrantReading[] = [];

  for (const grant of ordered) {
    const own = vestsOf(input.vests, grant.id);
    let vestedShares = 0;
    let remainingShares = 0;

    for (const vest of own) {
      const qualifiedFrom = qualifiesOn(grant.grantedOn);

      if (compareDates(vest.vestedOn, asOf) > 0) {
        future.push({ vest, grant, qualifiedFrom });
        continue;
      }

      const lot = lotFrom(vest, grant, input.sales, asOf);
      lots.push(lot);
      vestedShares += vest.shares;
      remainingShares += lot.remainingShares;
    }

    const scheduledShares = own.reduce((running, vest) => running + vest.shares, 0);
    grantReadings.push({
      grant,
      totalShares: grant.totalShares,
      scheduledShares,
      unscheduledShares: grant.totalShares - scheduledShares,
      vestedShares,
      remainingShares,
    });
  }

  lots.sort(
    (left, right) =>
      compareDates(left.vest.vestedOn, right.vest.vestedOn) || left.vest.id.localeCompare(right.vest.id),
  );
  future.sort(
    (left, right) =>
      compareDates(left.vest.vestedOn, right.vest.vestedOn) || left.vest.id.localeCompare(right.vest.id),
  );

  const held = lots.filter((lot) => lot.remainingShares > 0);
  const qualified = held.filter((lot) => lot.qualified);
  const unqualified = held.filter((lot) => !lot.qualified);
  const count = (set: readonly Lot[]) => set.reduce((running, lot) => running + lot.remainingShares, 0);

  return {
    asOf,
    lots,
    qualifiedShares: count(qualified),
    unqualifiedShares: count(unqualified),
    remainingShares: count(held),
    soldShares: lots.reduce((running, lot) => running + lot.soldShares, 0),
    qualifiedValueAtVest: sum(
      qualified.map((lot) => lot.remainingValueAtVest),
      currency,
    ),
    unqualifiedValueAtVest: sum(
      unqualified.map((lot) => lot.remainingValueAtVest),
      currency,
    ),
    future,
    futureShares: future.reduce((running, entry) => running + entry.vest.shares, 0),
    grants: grantReadings,
  };
}

/**
 * The day the next unqualified lot crosses its boundary, or `null` when every held
 * lot has already crossed. What the position is waiting on, in one date.
 */
export function nextQualificationDate(position: RsuPosition): CalendarDate | null {
  const pending = position.lots
    .filter((lot) => lot.remainingShares > 0 && !lot.qualified)
    .map((lot) => lot.qualifiedFrom)
    .sort(compareDates);
  return pending[0] ?? null;
}

/** An empty position, for a household that has recorded nothing yet. */
export function emptyPosition(asOf: CalendarDate, currency: Currency = "USD"): RsuPosition {
  return {
    asOf,
    lots: [],
    qualifiedShares: 0,
    unqualifiedShares: 0,
    remainingShares: 0,
    soldShares: 0,
    qualifiedValueAtVest: zero(currency),
    unqualifiedValueAtVest: zero(currency),
    future: [],
    futureShares: 0,
    grants: [],
  };
}
