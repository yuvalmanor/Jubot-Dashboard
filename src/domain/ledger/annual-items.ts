/**
 * Annual Items and Renewals — the typed half of מעקב תעריפים.
 *
 * Framework-free per ADR 0004. Plain data in, plain data out.
 *
 * A **פריט שנתי** is a named thing billed about once a year — ביטוח רכב מקיף,
 * רו"ח, רישוי — and a **חידוש** is that thing's price on one date. This is the
 * half the ledger cannot supply: the מאזן records that 4,104₪ left the account in
 * September, under `רכב`, and has nowhere to say that the figure *is* the
 * comprehensive policy and that last year's was 5,139.
 *
 * It sits beside `rate-watch.ts` rather than under a folder of its own because
 * the reading that consumes it is there, and the panel both feed is the מאזן's.
 * What it emphatically is **not** is ledger data: nothing here writes `entries`,
 * and nothing derived from it is ever added to a מאזן total. The money is already
 * counted by the grid — these rows are its breakdown, and adding the two would
 * count the same shekel twice.
 *
 * Four rules give the model its shape:
 *
 * - **The amount is the policy total**, whatever number of תשלומים it was billed
 *   in, because that is the number being negotiated. Dividing it by twelve is a
 *   reading, done on the way to the screen and stored nowhere.
 * - **The year is derived from the date**, never stored and never typed. A
 *   September renewal cannot be filed under the wrong year by hand.
 * - **Two renewals in one calendar year both survive.** The key is the item and
 *   the day, so a policy that slips from December to January overwrites nothing.
 * - **An item's life begins where its price history begins.** Recording a renewal
 *   older than the item's `startedOn` moves the start back to it, so backfilling
 *   last year's quote is an ordinary act rather than a refusal — and a year before
 *   that start is a year the item did not exist, which is a different fact from a
 *   year it was not renewed in.
 *
 * Correction ships with entry rather than after it: a Renewal can be corrected and
 * removed, because a form used about six times a year that can produce a typo and
 * cannot fix it is a trap. An **Annual Item**, by contrast, is never deleted —
 * ending one is a lifespan, which Phase 26 puts on screen.
 */

import { type Currency, type Money } from "@/domain/money/money";
import { type CalendarDate, compareDates, dateKey } from "@/domain/time/calendar-date";

/**
 * ILS only, for now.
 *
 * The currency is still explicit and still required on every stored amount,
 * exactly as it is everywhere else in this schema, so recording a USD
 * subscription later is an addition rather than a migration. Until then a
 * foreign-currency amount is **refused** rather than silently coerced: a $20
 * charge recorded as 20₪ would report the next exchange-rate move as a price
 * rise, which is the one thing this panel exists to detect.
 */
export const RATE_WATCH_CURRENCY: Currency = "ILS";

export interface AnnualItem {
  readonly id: string;
  /** The household's own naming — `ביטוח רכב מקיף`. Unique across the household. */
  readonly name: string;
  /** Where the price history begins: the earliest Renewal recorded against it. */
  readonly startedOn: CalendarDate;
  /**
   * Retirement is a lifespan, never a delete. `null` means the item is still
   * live. Phase 26 is what puts an ending on screen; the column is here because
   * ending an item must never mean losing the years it was recorded in.
   */
  readonly endedOn: CalendarDate | null;
}

export interface Renewal {
  readonly itemId: string;
  readonly renewedOn: CalendarDate;
  /** The **policy total**, not one תשלום of it. */
  readonly amount: Money;
}

export interface AnnualItems {
  readonly items: readonly AnnualItem[];
  readonly renewals: readonly Renewal[];
}

export const EMPTY_ANNUAL_ITEMS: AnnualItems = { items: [], renewals: [] };

export class InvalidAnnualItemError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidAnnualItemError";
  }
}

export class DuplicateAnnualItemNameError extends Error {
  // Deliberately not `name`: that is Error's own field, and shadowing it would
  // leave the class unable to say which name clashed.
  constructor(readonly itemName: string) {
    super(`An annual item named "${itemName}" already exists`);
    this.name = "DuplicateAnnualItemNameError";
  }
}

export class UnknownAnnualItemError extends Error {
  constructor(readonly itemId: string) {
    super(`No such annual item: ${itemId}`);
    this.name = "UnknownAnnualItemError";
  }
}

export class InvalidRenewalError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidRenewalError";
  }
}

/** A currency this panel does not hold yet. Refused, never coerced into shekels. */
export class UnsupportedRenewalCurrencyError extends Error {
  constructor(readonly currency: string) {
    super(`מעקב תעריפים records ${RATE_WATCH_CURRENCY} only, received ${currency}`);
    this.name = "UnsupportedRenewalCurrencyError";
  }
}

export class DuplicateRenewalError extends Error {
  constructor(readonly itemId: string, readonly renewedOn: CalendarDate) {
    super(`Item ${itemId} already has a renewal on ${dateKey(renewedOn)}`);
    this.name = "DuplicateRenewalError";
  }
}

export class UnknownRenewalError extends Error {
  constructor(readonly itemId: string, readonly renewedOn: CalendarDate) {
    super(`Item ${itemId} has no renewal on ${dateKey(renewedOn)}`);
    this.name = "UnknownRenewalError";
  }
}

/** The supplied set is not a valid model — a bug or corrupt data, not user error. */
export class MalformedAnnualItemsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MalformedAnnualItemsError";
  }
}

function normalise(value: string): string {
  return value.trim().replace(/\s+/g, " ");
}

function requireItemName(name: string): string {
  const normalised = normalise(name);
  if (normalised.length === 0) {
    throw new InvalidAnnualItemError("An annual item name cannot be empty");
  }
  if (normalised.length > 60) {
    throw new InvalidAnnualItemError(
      `An annual item name cannot exceed 60 characters, received ${normalised.length}`,
    );
  }
  return normalised;
}

function sameName(left: string, right: string): boolean {
  return normalise(left).toLocaleLowerCase() === normalise(right).toLocaleLowerCase();
}

/**
 * A renewal's amount. Positive, because a policy that cost nothing was not
 * renewed — and in the currency this panel holds, or refused.
 */
function requireAmount(amount: Money): Money {
  if (amount.currency !== RATE_WATCH_CURRENCY) {
    throw new UnsupportedRenewalCurrencyError(amount.currency);
  }
  if (amount.minorUnits <= 0) {
    throw new InvalidRenewalError(
      `A renewal amount must be positive, received ${String(amount.minorUnits)} minor units`,
    );
  }
  return amount;
}

/**
 * Build and validate. Every rule the database enforces is re-checked here,
 * because the domain is also handed data by tests, which do not go through
 * Postgres.
 */
export function buildAnnualItems(input: {
  readonly items: readonly AnnualItem[];
  readonly renewals: readonly Renewal[];
}): AnnualItems {
  const byId = new Map<string, AnnualItem>();

  for (const item of input.items) {
    if (byId.has(item.id)) {
      throw new MalformedAnnualItemsError(`Annual item ${item.id} appears twice`);
    }
    if (item.endedOn !== null && compareDates(item.endedOn, item.startedOn) < 0) {
      throw new MalformedAnnualItemsError(`Annual item ${item.id} ends before it starts`);
    }
    const clash = [...byId.values()].find((other) => sameName(other.name, item.name));
    if (clash !== undefined) {
      throw new DuplicateAnnualItemNameError(item.name);
    }
    byId.set(item.id, item);
  }

  const seen = new Set<string>();
  for (const renewal of input.renewals) {
    const item = byId.get(renewal.itemId);
    if (item === undefined) {
      throw new UnknownAnnualItemError(renewal.itemId);
    }
    const key = `${renewal.itemId}@${dateKey(renewal.renewedOn)}`;
    if (seen.has(key)) {
      throw new DuplicateRenewalError(renewal.itemId, renewal.renewedOn);
    }
    seen.add(key);
    requireAmount(renewal.amount);
    // An item's life begins at its earliest price, so a renewal before it means
    // the two disagree about when the thing started — never a valid state.
    if (compareDates(renewal.renewedOn, item.startedOn) < 0) {
      throw new MalformedAnnualItemsError(
        `Renewal ${key} precedes the item's own start on ${dateKey(item.startedOn)}`,
      );
    }
  }

  return { items: [...input.items], renewals: [...input.renewals] };
}

export function findAnnualItem(model: AnnualItems, id: string): AnnualItem | undefined {
  return model.items.find((item) => item.id === id);
}

/** One item's renewals, oldest first — the order a price history is read in. */
export function renewalsOf(model: AnnualItems, itemId: string): readonly Renewal[] {
  return model.renewals
    .filter((renewal) => renewal.itemId === itemId)
    .sort((left, right) => compareDates(left.renewedOn, right.renewedOn));
}

/** The newest price recorded for an item, or `undefined` where none is. */
export function latestRenewal(model: AnnualItems, itemId: string): Renewal | undefined {
  const history = renewalsOf(model, itemId);
  return history[history.length - 1];
}

/** Whether a calendar year falls inside an item's life. Both ends inclusive. */
export function coversYear(item: AnnualItem, year: number): boolean {
  if (year < item.startedOn.year) return false;
  return item.endedOn === null || year <= item.endedOn.year;
}

/** Items in Hebrew alphabetical order — the stable order behind any other. */
export function annualItemsByName(model: AnnualItems): readonly AnnualItem[] {
  return [...model.items].sort((left, right) => left.name.localeCompare(right.name, "he"));
}

// --- creating an item, with the price that starts its history ------------------

export interface CreateAnnualItemRequest {
  readonly name: string;
  /** The first Renewal. An item exists to hold prices, so it arrives with one. */
  readonly renewedOn: CalendarDate;
  readonly amount: Money;
}

/**
 * Everything one creation writes: the item and its first Renewal, as one
 * indivisible result. There is no shape here that leaves an item with a life but
 * no price in it — which is also what makes `startedOn` a fact rather than a
 * guess, since it is that first renewal's own date.
 */
export interface AnnualItemCreation {
  readonly item: AnnualItem;
  readonly renewal: Renewal;
}

export function planAnnualItemCreation(
  model: AnnualItems,
  request: CreateAnnualItemRequest,
  ids: { readonly itemId: string },
): AnnualItemCreation {
  const name = requireItemName(request.name);
  const clash = model.items.find((item) => sameName(item.name, name));
  if (clash !== undefined) {
    throw new DuplicateAnnualItemNameError(name);
  }

  const amount = requireAmount(request.amount);

  return {
    item: { id: ids.itemId, name, startedOn: request.renewedOn, endedOn: null },
    renewal: { itemId: ids.itemId, renewedOn: request.renewedOn, amount },
  };
}

export function applyAnnualItemCreation(
  model: AnnualItems,
  creation: AnnualItemCreation,
): AnnualItems {
  return buildAnnualItems({
    items: [...model.items, creation.item],
    renewals: [...model.renewals, creation.renewal],
  });
}

// --- recording, correcting and removing a price -------------------------------

/**
 * One Renewal to write, and the item's start where the renewal is older than it.
 *
 * `startedOn` is `null` in the ordinary case — this year's quote against an item
 * that already reaches back — and carries a date when the price being recorded
 * predates the item's own life. An item's life begins where its price history
 * begins, so backfilling last September moves the start rather than being refused.
 */
export interface RenewalRecording {
  readonly renewal: Renewal;
  readonly startedOn: CalendarDate | null;
}

export function planRenewal(
  model: AnnualItems,
  itemId: string,
  request: { readonly renewedOn: CalendarDate; readonly amount: Money },
): RenewalRecording {
  const item = findAnnualItem(model, itemId);
  if (item === undefined) {
    throw new UnknownAnnualItemError(itemId);
  }

  const existing = renewalsOf(model, itemId).find((renewal) =>
    compareDates(renewal.renewedOn, request.renewedOn) === 0,
  );
  if (existing !== undefined) {
    throw new DuplicateRenewalError(itemId, request.renewedOn);
  }

  return {
    renewal: { itemId, renewedOn: request.renewedOn, amount: requireAmount(request.amount) },
    startedOn: compareDates(request.renewedOn, item.startedOn) < 0 ? request.renewedOn : null,
  };
}

export function applyRenewal(model: AnnualItems, recording: RenewalRecording): AnnualItems {
  return buildAnnualItems({
    items: withStart(model.items, recording.renewal.itemId, recording.startedOn),
    renewals: [...model.renewals, recording.renewal],
  });
}

/**
 * A correction is the same renewal at a possibly different date and amount —
 * `from` is the day it is filed under now, and the renewal is what it becomes.
 * Moving one onto a day the item already holds is refused rather than silently
 * merging two prices into one.
 */
export interface RenewalCorrection {
  readonly itemId: string;
  readonly from: CalendarDate;
  readonly renewal: Renewal;
  readonly startedOn: CalendarDate | null;
}

export function planRenewalCorrection(
  model: AnnualItems,
  itemId: string,
  from: CalendarDate,
  request: { readonly renewedOn: CalendarDate; readonly amount: Money },
): RenewalCorrection {
  const item = findAnnualItem(model, itemId);
  if (item === undefined) {
    throw new UnknownAnnualItemError(itemId);
  }

  const history = renewalsOf(model, itemId);
  const target = history.find((renewal) => compareDates(renewal.renewedOn, from) === 0);
  if (target === undefined) {
    throw new UnknownRenewalError(itemId, from);
  }

  const moved = compareDates(from, request.renewedOn) !== 0;
  if (
    moved &&
    history.some((renewal) => compareDates(renewal.renewedOn, request.renewedOn) === 0)
  ) {
    throw new DuplicateRenewalError(itemId, request.renewedOn);
  }

  return {
    itemId,
    from,
    renewal: { itemId, renewedOn: request.renewedOn, amount: requireAmount(request.amount) },
    startedOn: compareDates(request.renewedOn, item.startedOn) < 0 ? request.renewedOn : null,
  };
}

export function applyRenewalCorrection(
  model: AnnualItems,
  correction: RenewalCorrection,
): AnnualItems {
  return buildAnnualItems({
    items: withStart(model.items, correction.itemId, correction.startedOn),
    renewals: model.renewals.map((renewal) =>
      renewal.itemId === correction.itemId && compareDates(renewal.renewedOn, correction.from) === 0
        ? correction.renewal
        : renewal,
    ),
  });
}

export interface RenewalRemoval {
  readonly itemId: string;
  readonly renewedOn: CalendarDate;
}

/**
 * Remove one price. The item itself survives — nothing here deletes an Annual
 * Item — and an item left with no renewals reads as having no rate rather than as
 * having a rate of nought. Its `startedOn` stays where it was: a life does not
 * shrink because a figure was withdrawn.
 */
export function planRenewalRemoval(
  model: AnnualItems,
  itemId: string,
  renewedOn: CalendarDate,
): RenewalRemoval {
  if (findAnnualItem(model, itemId) === undefined) {
    throw new UnknownAnnualItemError(itemId);
  }
  const target = renewalsOf(model, itemId).find(
    (renewal) => compareDates(renewal.renewedOn, renewedOn) === 0,
  );
  if (target === undefined) {
    throw new UnknownRenewalError(itemId, renewedOn);
  }
  return { itemId, renewedOn };
}

export function applyRenewalRemoval(model: AnnualItems, removal: RenewalRemoval): AnnualItems {
  return buildAnnualItems({
    items: model.items,
    renewals: model.renewals.filter(
      (renewal) =>
        renewal.itemId !== removal.itemId ||
        compareDates(renewal.renewedOn, removal.renewedOn) !== 0,
    ),
  });
}

/** The items with one item's start moved back, or the items unchanged. */
function withStart(
  items: readonly AnnualItem[],
  itemId: string,
  startedOn: CalendarDate | null,
): readonly AnnualItem[] {
  if (startedOn === null) return items;
  return items.map((item) => (item.id === itemId ? { ...item, startedOn } : item));
}
