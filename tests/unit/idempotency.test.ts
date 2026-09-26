import { describe, it, expect } from "vitest";
import { getIdempotencyKey, isValidIdempotencyKey, fingerprint } from "../../src/lib/idempotency.js";

function ctx(header = "") {
  return { req: { header: (_n: string) => (header ? header : undefined) } };
}

describe("isValidIdempotencyKey", () => {
  it("accepts 8-128 alphanumerics/_/-", () => {
    expect(isValidIdempotencyKey("testkey123456")).toBe(true);
    expect(isValidIdempotencyKey("a".repeat(8))).toBe(true);
    expect(isValidIdempotencyKey("A-b_c9".padEnd(8, "x"))).toBe(true);
  });
  it("rejects short/long/spaced keys", () => {
    expect(isValidIdempotencyKey("short")).toBe(false);
    expect(isValidIdempotencyKey("has space 12345")).toBe(false);
    expect(isValidIdempotencyKey("a".repeat(129))).toBe(false);
  });
});

describe("getIdempotencyKey", () => {
  it("prefers header over body", () => {
    expect(getIdempotencyKey(ctx("hdr-key-123") as any, { idempotencyKey: "body-key-123" })).toBe("hdr-key-123");
  });
  it("falls back to body", () => {
    expect(getIdempotencyKey(ctx() as any, { idempotencyKey: "body-key-123" })).toBe("body-key-123");
  });
  it("returns null when absent", () => {
    expect(getIdempotencyKey(ctx() as any, {})).toBeNull();
  });
});

describe("fingerprint", () => {
  it("is stable under key reordering", () => {
    expect(fingerprint({ a: 1, b: 2 })).toBe(fingerprint({ b: 2, a: 1 }));
  });
  it("differs across payloads", () => {
    expect(fingerprint({ total: 100 })).not.toBe(fingerprint({ total: 200 }));
  });
});
