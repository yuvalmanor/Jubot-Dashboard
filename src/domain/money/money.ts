/**
 * Money — the value type every later phase depends on.
 *
 * Framework-free per ADR 0004: this module imports nothing from Next.js, React or
 * the database client. Plain data in, plain data out.
 *
 * An amount is always an integer number of minor units (אגורות, cents) plus an
 * explicit currency code. There are no floats and no bare numbers: a float cannot
 * hold 0.1 + 0.2, and a bare number cannot say which currency it is.
 *
 * All arithmetic runs on BigInt internally, so a rate like 3.65 is treated as the
 * exact fraction 365/100 rather than the nearest double. Results are rounded to the
 * target currency's minor unit, half away from zero.
 */

export type Currency = "ILS" | "USD";

/** Minor units per major unit, as digits. Both currencies here are 2. */
const MINOR_UNIT_DIGITS: Record<Currency, number> = {
  ILS: 2,
  USD: 2,
};

const CURRENCIES = Object.keys(MINOR_UNIT_DIGITS) as Currency[];

export interface Money {
  /** Integer minor units. 69_000_00 is $69,000.00. */
  readonly minorUnits: number;
  readonly currency: Currency;
}

/** A conversion is never implicit — it always names both sides and the rate used. */
export interface ExchangeRate {
  readonly from: Currency;
  readonly to: Currency;
  /** Units of `to` per one unit of `from`. */
  readonly rate: number;
}

export class InvalidMoneyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidMoneyError";
  }
}

export class CurrencyMismatchError extends Error {
  constructor(
    readonly left: Currency,
    readonly right: Currency,
  ) {
    super(`Cannot combine ${left} with ${right} — amounts in different currencies are not comparable`);
    this.name = "CurrencyMismatchError";
  }
}

export function isCurrency(value: unknown): value is Currency {
  return typeof value === "string" && (CURRENCIES as string[]).includes(value);
}

export function minorUnitDigits(currency: Currency): number {
  return MINOR_UNIT_DIGITS[currency];
}

/** Build a Money from integer minor units. Rejects anything that is not a safe integer. */
export function money(minorUnits: number, currency: Currency): Money {
  if (!Number.isSafeInteger(minorUnits)) {
    throw new InvalidMoneyError(
      `Amount must be an integer number of minor units, received ${String(minorUnits)}`,
    );
  }
  if (!isCurrency(currency)) {
    throw new InvalidMoneyError(`Unknown currency ${String(currency)}`);
  }
  return { minorUnits, currency };
}

export function zero(currency: Currency): Money {
  return money(0, currency);
}

/**
 * Build a Money from major units — 69000 or "69000.005". A decimal string is read
 * exactly; a JS number is read from its shortest round-trip representation. Extra
 * precision is rounded to the minor unit rather than silently truncated.
 */
export function fromMajorUnits(majorUnits: number | string, currency: Currency): Money {
  const fraction = decimalToFraction(majorUnits);
  const scale = 10n ** BigInt(minorUnitDigits(currency));
  return money(Number(divideRoundingHalfAwayFromZero(fraction.numerator * scale, fraction.denominator)), currency);
}

/** Lossy by construction — for display and charting only, never for arithmetic. */
export function toMajorUnits(amount: Money): number {
  return amount.minorUnits / 10 ** minorUnitDigits(amount.currency);
}

function assertSameCurrency(left: Money, right: Money): void {
  if (left.currency !== right.currency) {
    throw new CurrencyMismatchError(left.currency, right.currency);
  }
}

export function add(left: Money, right: Money): Money {
  assertSameCurrency(left, right);
  return money(left.minorUnits + right.minorUnits, left.currency);
}

export function subtract(left: Money, right: Money): Money {
  assertSameCurrency(left, right);
  return money(left.minorUnits - right.minorUnits, left.currency);
}

export function negate(amount: Money): Money {
  return money(-amount.minorUnits, amount.currency);
}

/**
 * Sum a list. An empty list has no currency of its own, so one must be supplied —
 * this is what stops an empty הוצאות list from quietly becoming zero shekels in a
 * dollar total.
 */
export function sum(amounts: readonly Money[], currency?: Currency): Money {
  const first = amounts[0];
  if (first === undefined) {
    if (currency === undefined) {
      throw new InvalidMoneyError("Cannot sum an empty list without an explicit currency");
    }
    return zero(currency);
  }
  const target = currency ?? first.currency;
  return amounts.reduce((running, next) => add(running, next), zero(target));
}

/** Multiply by a plain factor (a share, a count, a percentage as 0.25). */
export function multiply(amount: Money, factor: number | string): Money {
  const fraction = decimalToFraction(factor);
  return money(
    Number(
      divideRoundingHalfAwayFromZero(BigInt(amount.minorUnits) * fraction.numerator, fraction.denominator),
    ),
    amount.currency,
  );
}

export function compare(left: Money, right: Money): -1 | 0 | 1 {
  assertSameCurrency(left, right);
  if (left.minorUnits < right.minorUnits) return -1;
  if (left.minorUnits > right.minorUnits) return 1;
  return 0;
}

export function equals(left: Money, right: Money): boolean {
  return left.currency === right.currency && left.minorUnits === right.minorUnits;
}

export function isZero(amount: Money): boolean {
  return amount.minorUnits === 0;
}

export function isNegative(amount: Money): boolean {
  return amount.minorUnits < 0;
}

export function exchangeRate(from: Currency, to: Currency, rate: number): ExchangeRate {
  if (!isCurrency(from) || !isCurrency(to)) {
    throw new InvalidMoneyError(`Unknown currency in rate ${String(from)}/${String(to)}`);
  }
  if (!Number.isFinite(rate) || rate <= 0) {
    throw new InvalidMoneyError(`Exchange rate must be a positive finite number, received ${String(rate)}`);
  }
  return { from, to, rate };
}

/**
 * Convert at an explicit rate. The rate carries the pair it applies to, so a USD
 * amount can never be converted with a rate that was quoted for something else.
 */
export function convert(amount: Money, rate: ExchangeRate): Money {
  if (amount.currency !== rate.from) {
    throw new CurrencyMismatchError(amount.currency, rate.from);
  }
  const fraction = decimalToFraction(rate.rate);
  let numerator = BigInt(amount.minorUnits) * fraction.numerator;
  let denominator = fraction.denominator;

  const scaleShift = minorUnitDigits(rate.to) - minorUnitDigits(rate.from);
  if (scaleShift > 0) {
    numerator *= 10n ** BigInt(scaleShift);
  } else if (scaleShift < 0) {
    denominator *= 10n ** BigInt(-scaleShift);
  }

  return money(Number(divideRoundingHalfAwayFromZero(numerator, denominator)), rate.to);
}

export interface FormatOptions {
  /** Defaults to Hebrew — the UI language. */
  readonly locale?: string;
  /** Drop the currency symbol, e.g. inside a column that names its currency once. */
  readonly withSymbol?: boolean;
}

/** Format for reading. Hebrew locale by default: grouped thousands, symbol trailing. */
export function format(amount: Money, options: FormatOptions = {}): string {
  const { locale = "he-IL", withSymbol = true } = options;
  const digits = minorUnitDigits(amount.currency);
  const formatter = new Intl.NumberFormat(locale, {
    ...(withSymbol ? { style: "currency" as const, currency: amount.currency } : {}),
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  });
  return formatter.format(toMajorUnits(amount));
}

// --- exact decimal arithmetic ------------------------------------------------

interface Fraction {
  readonly numerator: bigint;
  readonly denominator: bigint;
}

const DECIMAL_PATTERN = /^([+-]?)(\d+)(?:\.(\d+))?(?:[eE]([+-]?\d+))?$/;

/**
 * Read a decimal into an exact fraction. A JS number goes through its shortest
 * round-trip string, so 3.65 becomes 365/100 rather than the double nearest to it.
 */
function decimalToFraction(value: number | string): Fraction {
  if (typeof value === "number" && !Number.isFinite(value)) {
    throw new InvalidMoneyError(`Expected a finite decimal, received ${String(value)}`);
  }
  const text = typeof value === "number" ? value.toString() : value.trim();
  const match = DECIMAL_PATTERN.exec(text);
  if (match === null) {
    throw new InvalidMoneyError(`Expected a decimal number, received ${JSON.stringify(value)}`);
  }
  const [, sign = "", integerPart = "0", fractionPart = "", exponentPart = "0"] = match;

  let numerator = BigInt(integerPart + fractionPart);
  let denominator = 1n;
  const exponent = Number(exponentPart) - fractionPart.length;
  if (exponent > 0) {
    numerator *= 10n ** BigInt(exponent);
  } else if (exponent < 0) {
    denominator = 10n ** BigInt(-exponent);
  }
  if (sign === "-") {
    numerator = -numerator;
  }
  return { numerator, denominator };
}

/** Round half away from zero, so -0.5 goes to -1 and 0.5 goes to 1. */
function divideRoundingHalfAwayFromZero(numerator: bigint, denominator: bigint): bigint {
  if (denominator <= 0n) {
    throw new InvalidMoneyError("Denominator must be positive");
  }
  const negative = numerator < 0n;
  const magnitude = negative ? -numerator : numerator;
  const quotient = magnitude / denominator;
  const remainder = magnitude % denominator;
  const rounded = remainder * 2n >= denominator ? quotient + 1n : quotient;
  return negative ? -rounded : rounded;
}
