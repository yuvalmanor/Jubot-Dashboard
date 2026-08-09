import { describe, expect, it } from "vitest";

import { isAllowed, parseAllowList } from "./allow-list";

const household = ["yuval@example.com", "eden@example.com"];

describe("parseAllowList", () => {
  it("reads a comma-separated list, ignoring spacing and case", () => {
    expect(parseAllowList(" Yuval@Example.com , eden@example.com ")).toEqual(household);
  });

  it("treats an unset or empty setting as an empty list", () => {
    expect(parseAllowList(undefined)).toEqual([]);
    expect(parseAllowList("")).toEqual([]);
    expect(parseAllowList(" , , ")).toEqual([]);
  });
});

describe("isAllowed", () => {
  it("admits either household account", () => {
    expect(isAllowed("yuval@example.com", household)).toBe(true);
    expect(isAllowed("eden@example.com", household)).toBe(true);
  });

  it("ignores case and surrounding whitespace", () => {
    expect(isAllowed("  YUVAL@Example.COM ", household)).toBe(true);
  });

  it("refuses anyone else", () => {
    expect(isAllowed("stranger@example.com", household)).toBe(false);
    expect(isAllowed("yuval@example.com.evil.com", household)).toBe(false);
    expect(isAllowed("yuval@example.co", household)).toBe(false);
  });

  it("refuses a missing address", () => {
    expect(isAllowed(undefined, household)).toBe(false);
    expect(isAllowed(null, household)).toBe(false);
    expect(isAllowed("", household)).toBe(false);
    expect(isAllowed("   ", household)).toBe(false);
  });

  it("fails closed when the list is unset", () => {
    expect(isAllowed("yuval@example.com", [])).toBe(false);
  });
});
