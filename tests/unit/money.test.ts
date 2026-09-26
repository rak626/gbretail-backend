import { describe, it, expect } from "vitest";
import { round2, parseMoney, dec, MAX_MONEY } from "../../src/lib/money.js";

describe("round2", () => {
  it("rounds to 2dp", () => {
    expect(round2(10.005)).toBe(10.01);
    expect(round2(10.004)).toBe(10);
    expect(round2(0)).toBe(0);
  });
  it("returns NaN for non-numbers", () => {
    expect(round2(NaN)).toBeNaN();
    expect(round2(Infinity)).toBeNaN();
    expect(round2("5" as unknown as number)).toBeNaN();
  });
});

describe("parseMoney", () => {
  it("parses numbers and numeric strings with 2dp rounding", () => {
    expect(parseMoney(10)).toBe(10);
    expect(parseMoney("  20.456 ")).toBe(20.46);
    expect(parseMoney("0")).toBe(0);
  });
  it("returns NaN when invalid", () => {
    expect(parseMoney("abc")).toBeNaN();
    expect(parseMoney(undefined)).toBeNaN();
    expect(parseMoney(Infinity)).toBeNaN();
  });
});

describe("dec", () => {
  it("passes through numbers and nullish", () => {
    expect(dec(null)).toBe(0);
    expect(dec(undefined)).toBe(0);
    expect(dec(5.5)).toBe(5.5);
  });
  it("converts strings", () => {
    expect(dec("12.34")).toBe(12.34);
  });
  it("converts Decimal-like objects", () => {
    expect(dec({ toNumber: () => 7.25 })).toBe(7.25);
  });
  it("falls back for throwing Decimal", () => {
    expect(dec({ toNumber: () => { throw new Error("x"); }, toString: () => "9.5" })).toBe(9.5);
  });
});

describe("MAX_MONEY", () => {
  it("is the 1-crore cap", () => {
    expect(MAX_MONEY).toBe(10000000);
  });
});
