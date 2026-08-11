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

/**
 * Read what a person typed into a field. Accepts the grouping and currency marks
 * a Hebrew keyboard produces around a number — `12,500.40`, `‏12 500‏`, `₪1,200`,
 * a Unicode minus — and rejects everything else rather than guessing.
 *
 * Blank is `null`, not zero: an empty field means the figure was not recorded,
 * and that is a different fact from a figure of zero.
 */
export function parseMoneyInput(text: string, currency: Currency): Money | null {
  const stripped = text
    .replace(/[‎‏؜]/g, "") // bidi marks an RTL field leaves behind
    .replace(/[\s  ,']/g, "") // grouping: space, nbsp, narrow nbsp, comma, geresh
    .replace(/[₪$]/g, "") // a currency symbol typed into the field
    .replace(/[−‒–—]/g, "-"); // minus sign and dashes that are not hyphen-minus

  if (stripped.length === 0) return null;

  // ".5" and "5." are what a half-typed field looks like, not an error.
  const normalised = stripped.replace(/^([+-]?)\./, "$10.").replace(/\.$/, "");
  if (!/^[+-]?\d+(\.\d+)?$/.test(normalised)) {
    throw new InvalidMoneyError(`Expected an amount, received ${JSON.stringify(text)}`);
  }
  return fromMajorUnits(normalised, currency);
}

/** Lossy by construction — for display and charting only, never for arithmetic. */
export function toMajorUnits(amount: Money): number {
  return amount.minorUnits / 10 ** minorUnitDigits(amount.currency);
}

/**
 * The exact decimal, ungrouped and unsymbolled — `1234.50`. This is what goes back
 * into an input field: `parseMoneyInput` reads it to the same minor units it came
 * from, so re-saving an untouched field cannot drift the figure.
 */
export function toDecimalString(amount: Money): string {
  return fromScaledInteger(amount.minorUnits, minorUnitDigits(amount.currency));
}

/**
 * Read a decimal into an integer count of 10⁻ⁿ units, rounded half away from zero
 * — the same reading `fromMajorUnits` does, at whatever scale is asked for.
 *
 * Money uses it at the minor unit. A price *per share* needs a finer one: GP
 * 149.4219 is a real figure off a real statement, and cents cannot hold it. A
 * price is not an amount of money, so it does not become one by being rounded to
 * something Money can carry.
 */
export function toScaledInteger(value: number | string, digits: number): number {
  if (!Number.isInteger(digits) || digits < 0) {
    throw new InvalidMoneyError(`Scale must be a whole number of digits, received ${String(digits)}`);
  }
  const fraction = decimalToFraction(value);
  const scale = 10n ** BigInt(digits);
  const scaled = divideRoundingHalfAwayFromZero(fraction.numerator * scale, fraction.denominator);
  if (scaled > BigInt(Number.MAX_SAFE_INTEGER) || scaled < BigInt(Number.MIN_SAFE_INTEGER)) {
    throw new InvalidMoneyError(`${String(value)} does not fit in a safe integer at ${digits} digits`);
  }
  return Number(scaled);
}

/** The exact decimal text of a scaled integer — the inverse of `toScaledInteger`. */
export function fromScaledInteger(units: number, digits: number): string {
  const magnitude = Math.abs(units).toString().padStart(digits + 1, "0");
  const whole = magnitude.slice(0, magnitude.length - digits);
  const fraction = magnitude.slice(magnitude.length - digits);
  return `${units < 0 ? "-" : ""}${whole}${digits === 0 ? "" : `.${fraction}`}`;
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

/**
 * Divide by a plain divisor — a total over a count of months. Exact: the divisor
 * is read as a fraction and the result rounded at the minor unit, so an average
 * of three months does not drift by an agora.
 */
export function divide(amount: Money, divisor: number | string): Money {
  const fraction = decimalToFraction(divisor);
  if (fraction.numerator === 0n) {
    throw new InvalidMoneyError("Cannot divide an amount by zero");
  }
  let numerator = BigInt(amount.minorUnits) * fraction.denominator;
  let denominator = fraction.numerator;
  if (denominator < 0n) {
    numerator = -numerator;
    denominator = -denominator;
  }
  return money(Number(divideRoundingHalfAwayFromZero(numerator, denominator)), amount.currency);
}

/**
 * One amount as a share of another — חיסכון against הכנסות, a category against a
 * month's total. Returns a plain number because a ratio is not money.
 *
 * A share of nothing is `null`, never zero: a month with no income did not save
 * 0% of it, it has no percentage to state. The caller is left to say so rather
 * than print a figure that reads as a measurement.
 */
export function ratio(numerator: Money, denominator: Money): number | null {
  assertSameCurrency(numerator, denominator);
  if (denominator.minorUnits === 0) return null;
  return numerator.minorUnits / denominator.minorUnits;
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

/**
 * Convert against the direction a rate is quoted in — shekels read back as dollars
 * at a `USD/ILS` rate. Dividing by the stored rate rather than multiplying by an
 * inverted one is what keeps one rate authoritative: an inverse rounded to a few
 * decimals is a second rate, and two rates for one pair is precisely how a שקל
 * table and a דולר table drift apart from each other.
 */
export function convertBack(amount: Money, rate: ExchangeRate): Money {
  if (amount.currency !== rate.to) {
    throw new CurrencyMismatchError(amount.currency, rate.to);
  }
  const fraction = decimalToFraction(rate.rate);
  if (fraction.numerator <= 0n) {
    throw new InvalidMoneyError(`Cannot convert back at a rate of ${String(rate.rate)}`);
  }
  let numerator = BigInt(amount.minorUnits) * fraction.denominator;
  let denominator = fraction.numerator;

  const scaleShift = minorUnitDigits(rate.from) - minorUnitDigits(rate.to);
  if (scaleShift > 0) {
    numerator *= 10n ** BigInt(scaleShift);
  } else if (scaleShift < 0) {
    denominator *= 10n ** BigInt(-scaleShift);
  }

  return money(Number(divideRoundingHalfAwayFromZero(numerator, denominator)), rate.from);
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
