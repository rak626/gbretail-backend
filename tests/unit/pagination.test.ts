import { describe, it, expect } from "vitest";
import { encodeCursor, decodeCursor, cursorWhere, parseLimit } from "../../src/lib/pagination.js";

describe("cursor encode/decode", () => {
  it("round-trips createdAt + id", () => {
    const d = new Date("2026-01-15T10:00:00.000Z");
    const cur = encodeCursor(d, "abc123");
    expect(decodeCursor(cur)).toEqual({ createdAt: d.toISOString(), id: "abc123" });
  });
  it("accepts string dates", () => {
    const cur = encodeCursor("2026-01-15T10:00:00.000Z", "x");
    expect(decodeCursor(cur)?.id).toBe("x");
  });
  it("rejects bogus/empty/bad-date cursors", () => {
    expect(decodeCursor(null)).toBeNull();
    expect(decodeCursor("")).toBeNull();
    expect(decodeCursor("bogus")).toBeNull();
    expect(decodeCursor(Buffer.from("not-a-date|id").toString("base64url"))).toBeNull();
  });
});

describe("cursorWhere", () => {
  it("returns null without a cursor", () => {
    expect(cursorWhere(null)).toBeNull();
  });
  it("builds (createdAt desc, id desc) condition", () => {
    const w = cursorWhere({ createdAt: "2026-01-15T10:00:00.000Z", id: "abc" }) as any;
    expect(w.OR).toHaveLength(2);
    expect(w.OR[0]).toEqual({ createdAt: { lt: new Date("2026-01-15T10:00:00.000Z") } });
  });
});

describe("parseLimit", () => {
  it("clamps to 1..max", () => {
    expect(parseLimit("0", 50, 100)).toBe(1);
    expect(parseLimit("500", 50, 100)).toBe(100);
    expect(parseLimit("25", 50, 100)).toBe(25);
    expect(parseLimit("abc", 50, 100)).toBe(50);
    expect(parseLimit(undefined, 50, 100)).toBe(50);
  });
});
