import { describe, expect, it } from "vitest";

import {
  CurrencyMismatchError,
  InvalidMoneyError,
  add,
  compare,
  convert,
  equals,
  exchangeRate,
  format,
  fromMajorUnits,
  isNegative,
  isZero,
  money,
  multiply,
  negate,
  subtract,
  sum,
  toMajorUnits,
  zero,
} from "./money";

/**
 * Hebrew formatting embeds bidi control marks so the symbol sits correctly inside
 * RTL text. They are invisible and carry no value, so tests compare the stripped
 * form — the marks themselves are asserted separately.
 */
function withoutBidiMarks(text: string): string {
  return text.replace(/[‎‏؜]/g, "").replace(/[  ]/g, " ");
}

describe("construction", () => {
  it("holds integer minor units with an explicit currency", () => {
    const amount = money(6_900_000, "USD");
    expect(amount.minorUnits).toBe(6_900_000);
    expect(amount.currency).toBe("USD");
  });

  it("refuses a non-integer amount rather than rounding behind the caller's back", () => {
    expect(() => money(1234.5, "ILS")).toThrow(InvalidMoneyError);
  });

  it("refuses an unknown currency", () => {
    expect(() => money(100, "EUR" as never)).toThrow(InvalidMoneyError);
  });

  it("builds from major units at the minor-unit boundary", () => {
    expect(fromMajorUnits(69_000, "USD")).toEqual({ minorUnits: 6_900_000, currency: "USD" });
    expect(fromMajorUnits(109_800, "ILS")).toEqual({ minorUnits: 10_980_000, currency: "ILS" });
    expect(fromMajorUnits("1234.56", "ILS").minorUnits).toBe(123_456);
  });

  it("reads a decimal string exactly instead of through a float", () => {
    // 0.1 + 0.2 is 0.30000000000000004 as a double; it is still 30 agorot.
    expect(fromMajorUnits(0.1 + 0.2, "ILS").minorUnits).toBe(30);
    expect(fromMajorUnits("0.005", "ILS").minorUnits).toBe(1);
    expect(fromMajorUnits("-0.005", "ILS").minorUnits).toBe(-1);
  });

  it("has a zero for each currency", () => {
    expect(zero("ILS")).toEqual({ minorUnits: 0, currency: "ILS" });
    expect(isZero(zero("USD"))).toBe(true);
  });

  it("converts back to major units for display", () => {
    expect(toMajorUnits(money(123_456, "ILS"))).toBe(1234.56);
  });
});

describe("arithmetic within one currency", () => {
  it("adds and subtracts in exact minor units", () => {
    expect(add(money(10_01, "ILS"), money(20_02, "ILS")).minorUnits).toBe(30_03);
    expect(subtract(money(10_00, "ILS"), money(30_00, "ILS")).minorUnits).toBe(-20_00);
  });

  it("does not accumulate float error across many additions", () => {
    // The classic 0.1 × 10 problem: exact here by construction.
    const tenAgorot = fromMajorUnits("0.1", "ILS");
    const total = Array.from({ length: 10 }, () => tenAgorot).reduce(add);
    expect(total.minorUnits).toBe(100);
    expect(equals(total, fromMajorUnits(1, "ILS"))).toBe(true);
  });

  it("negates and reports sign", () => {
    expect(negate(money(5_00, "USD")).minorUnits).toBe(-5_00);
    expect(isNegative(money(-1, "ILS"))).toBe(true);
    expect(isNegative(zero("ILS"))).toBe(false);
  });

  it("multiplies by a plain factor, rounding to the minor unit", () => {
    expect(multiply(money(10_00, "ILS"), 0.1).minorUnits).toBe(100);
    expect(multiply(money(3, "ILS"), "0.5").minorUnits).toBe(2); // 1.5 → 2, half away from zero
    expect(multiply(money(-3, "ILS"), "0.5").minorUnits).toBe(-2); // -1.5 → -2
    expect(multiply(money(100_00, "USD"), "0.6217").minorUnits).toBe(62_17);
  });

  it("compares and equates", () => {
    expect(compare(money(1, "ILS"), money(2, "ILS"))).toBe(-1);
    expect(compare(money(2, "ILS"), money(2, "ILS"))).toBe(0);
    expect(compare(money(3, "ILS"), money(2, "ILS"))).toBe(1);
    expect(equals(money(1, "ILS"), money(1, "USD"))).toBe(false);
  });

  it("sums a list, and needs an explicit currency for an empty one", () => {
    expect(sum([money(1_00, "ILS"), money(2_50, "ILS")]).minorUnits).toBe(3_50);
    expect(sum([], "USD")).toEqual({ minorUnits: 0, currency: "USD" });
    expect(() => sum([])).toThrow(InvalidMoneyError);
  });
});

describe("mixing currencies", () => {
  it("refuses to add shekels to dollars", () => {
    // CGM 1's two funding legs: 109,800₪ and $69,000. They do not add up.
    const shekelLeg = fromMajorUnits(109_800, "ILS");
    const dollarLeg = fromMajorUnits(69_000, "USD");
    expect(() => add(shekelLeg, dollarLeg)).toThrow(CurrencyMismatchError);
  });

  it("refuses to subtract, compare or sum across currencies", () => {
    expect(() => subtract(money(1, "ILS"), money(1, "USD"))).toThrow(CurrencyMismatchError);
    expect(() => compare(money(1, "ILS"), money(1, "USD"))).toThrow(CurrencyMismatchError);
    expect(() => sum([money(1, "ILS"), money(1, "USD")])).toThrow(CurrencyMismatchError);
  });

  it("names both currencies in the error", () => {
    expect(() => add(money(1, "ILS"), money(1, "USD"))).toThrow(/ILS.*USD/);
  });
});

describe("conversion at an explicit rate", () => {
  it("converts at the rate it is given", () => {
    const rate = exchangeRate("USD", "ILS", 3.65);
    expect(convert(fromMajorUnits(69_000, "USD"), rate)).toEqual({
      minorUnits: 25_185_000,
      currency: "ILS",
    });
  });

  it("treats the rate as an exact decimal, not as the nearest double", () => {
    // 3.65 as a double is 3.649999999999999911182...; naive multiplication of
    // 1,234,567 minor units by it lands a unit low.
    const rate = exchangeRate("USD", "ILS", 3.65);
    expect(convert(money(1_234_567, "USD"), rate).minorUnits).toBe(4_506_170);
  });

  it("rounds to the minor unit, half away from zero", () => {
    expect(convert(money(1, "USD"), exchangeRate("USD", "ILS", 3.5)).minorUnits).toBe(4);
    expect(convert(money(1, "USD"), exchangeRate("USD", "ILS", 3.4)).minorUnits).toBe(3);
    expect(convert(money(1, "USD"), exchangeRate("USD", "ILS", 3.655)).minorUnits).toBe(4);
    expect(convert(money(-1, "USD"), exchangeRate("USD", "ILS", 3.5)).minorUnits).toBe(-4);
  });

  it("refuses a rate quoted for a different currency", () => {
    const rate = exchangeRate("USD", "ILS", 3.65);
    expect(() => convert(fromMajorUnits(100, "ILS"), rate)).toThrow(CurrencyMismatchError);
  });

  it("refuses a rate that is not a positive finite number", () => {
    expect(() => exchangeRate("USD", "ILS", 0)).toThrow(InvalidMoneyError);
    expect(() => exchangeRate("USD", "ILS", -3.65)).toThrow(InvalidMoneyError);
    expect(() => exchangeRate("USD", "ILS", Number.NaN)).toThrow(InvalidMoneyError);
  });

  it("round-trips within one minor unit of rounding", () => {
    const toShekels = exchangeRate("USD", "ILS", 3.65);
    const toDollars = exchangeRate("ILS", "USD", 1 / 3.65);
    const original = fromMajorUnits(69_000, "USD");
    const returned = convert(convert(original, toShekels), toDollars);
    expect(Math.abs(returned.minorUnits - original.minorUnits)).toBeLessThanOrEqual(1);
  });
});

describe("Hebrew formatting", () => {
  it("formats shekels the Hebrew way — grouped thousands, symbol trailing", () => {
    expect(withoutBidiMarks(format(fromMajorUnits(69_000, "ILS")))).toBe("69,000.00 ₪");
    expect(withoutBidiMarks(format(money(0, "ILS")))).toBe("0.00 ₪");
    expect(withoutBidiMarks(format(fromMajorUnits("-1234.5", "ILS")))).toBe("-1,234.50 ₪");
  });

  it("formats dollars in the same Hebrew locale, with the dollar symbol", () => {
    expect(withoutBidiMarks(format(fromMajorUnits(69_000, "USD")))).toBe("69,000.00 $");
  });

  it("emits bidi marks so the symbol sits correctly inside RTL text", () => {
    expect(format(fromMajorUnits(1, "ILS"))).toMatch(/[‎‏]/);
  });

  it("always shows both minor-unit digits", () => {
    expect(withoutBidiMarks(format(money(100_50, "ILS")))).toBe("100.50 ₪");
    expect(withoutBidiMarks(format(money(100_00, "ILS")))).toBe("100.00 ₪");
  });

  it("can drop the symbol for a column that names its currency once", () => {
    expect(withoutBidiMarks(format(money(100_50, "ILS"), { withSymbol: false }))).toBe("100.50");
  });
});
