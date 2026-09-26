import { describe, it, expect } from "vitest";
import { startOfDay, endOfDay, addDays, computeDueDate } from "../../src/lib/utils.js";

describe("IST day bounds (host-timezone safe)", () => {
  it("startOfDay is 00:00 IST in UTC terms", () => {
    // 2026-09-27 10:00 IST == 04:30 UTC; start should be 2026-09-26T18:30Z
    const d = new Date("2026-09-27T04:30:00.000Z");
    expect(startOfDay(d).toISOString()).toBe("2026-09-26T18:30:00.000Z");
  });
  it("endOfDay is 23:59:59.999 IST", () => {
    const d = new Date("2026-09-27T04:30:00.000Z");
    expect(endOfDay(d).toISOString()).toBe("2026-09-27T18:29:59.999Z");
  });
  it("addDays shifts by whole days", () => {
    const d = new Date("2026-01-01T00:00:00.000Z");
    expect(addDays(d, 1).toISOString()).toBe("2026-01-02T00:00:00.000Z");
    expect(addDays(d, -30).toISOString()).toBe("2025-12-02T00:00:00.000Z");
  });
  it("computeDueDate lands on IST midnight + N days", () => {
    const due = computeDueDate(7);
    expect(due.getUTCHours()).toBe(18);
    expect(due.getUTCMinutes()).toBe(30);
  });
});
