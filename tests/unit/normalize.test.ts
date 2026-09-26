import { describe, it, expect } from "vitest";
import {
  normalizePhone,
  validatePhone,
  normalizeEmail,
  validateEmail,
  parseCreditDays,
  normalizeCreditTerm,
  clampCreditLimit,
} from "../../src/lib/normalize.js";

describe("normalizePhone", () => {
  it("keeps last 10 digits (country code tolerant)", () => {
    expect(normalizePhone("919876543210")).toBe("9876543210");
    expect(normalizePhone(" 98765 43210 ")).toBe("9876543210");
  });
  it("returns null for empty/non-digit", () => {
    expect(normalizePhone(null)).toBeNull();
    expect(normalizePhone("")).toBeNull();
    expect(normalizePhone("abc")).toBeNull();
  });
});

describe("validatePhone", () => {
  it("accepts 10 digits, null optional", () => {
    expect(validatePhone(null)).toBe(true);
    expect(validatePhone("9876543210")).toBe(true);
    expect(validatePhone("123")).toBe(false);
  });
});

describe("email helpers", () => {
  it("normalizes case/whitespace and caps length", () => {
    expect(normalizeEmail("  Foo@Bar.COM ")).toBe("foo@bar.com");
    expect(normalizeEmail("")).toBeNull();
    expect(normalizeEmail(null)).toBeNull();
  });
  it("validates shape", () => {
    expect(validateEmail(null)).toBe(true);
    expect(validateEmail("a@b.co")).toBe(true);
    expect(validateEmail("nope")).toBe(false);
  });
});

describe("parseCreditDays", () => {
  it("clamps 1..365 with fallback", () => {
    expect(parseCreditDays(0)).toBe(30);
    expect(parseCreditDays(500)).toBe(365);
    expect(parseCreditDays("15")).toBe(15);
    expect(parseCreditDays(NaN, 7)).toBe(7);
  });
});

describe("normalizeCreditTerm", () => {
  it("honors 7/15/30 creditTerm first", () => {
    expect(normalizeCreditTerm({ creditTerm: "15" })).toBe(15);
    expect(normalizeCreditTerm({ creditDays: 45 })).toBe(45);
    expect(normalizeCreditTerm({}, 10)).toBe(10);
  });
});

describe("clampCreditLimit", () => {
  it("parses 0..1M, null when blank", () => {
    expect(clampCreditLimit("")).toBeNull();
    expect(clampCreditLimit("500")).toBe(500);
    expect(() => clampCreditLimit(-1)).toThrow();
    expect(() => clampCreditLimit(2_000_000)).toThrow();
  });
});
