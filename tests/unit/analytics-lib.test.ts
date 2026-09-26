import { describe, it, expect } from "vitest";
import {
  qtyForItem,
  grossProfitForItem,
  allocateDiscountToItems,
  getLedgerAgingBucket,
} from "../../src/lib/analytics.js";
import { startOfDay, addDays } from "../../src/lib/utils.js";

describe("qtyForItem", () => {
  it("prefers positive weight, then quantity, else 1", () => {
    expect(qtyForItem({ price: 10, lineTotal: 10, weight: 2.5 })).toBe(2.5);
    expect(qtyForItem({ price: 10, lineTotal: 20, quantity: 2 })).toBe(2);
    expect(qtyForItem({ price: 10, lineTotal: 10 })).toBe(1);
  });
});

describe("grossProfitForItem", () => {
  it("is lineTotal minus cost*qty", () => {
    expect(grossProfitForItem({ price: 100, costPrice: 60, quantity: 2, lineTotal: 200 })).toBe(80);
  });
  it("treats null cost as zero profit drag", () => {
    expect(grossProfitForItem({ price: 50, costPrice: null, quantity: 1, lineTotal: 50 })).toBe(50);
  });
});

describe("allocateDiscountToItems", () => {
  it("splits proportionally and sums to discount", () => {
    const items = [
      { price: 100, lineTotal: 100 },
      { price: 300, lineTotal: 300 },
    ];
    const alloc = allocateDiscountToItems(items, 40, 400);
    expect(alloc[0]).toBeCloseTo(10);
    expect(alloc[1]).toBeCloseTo(30);
  });
  it("returns zeros without discount/gross", () => {
    expect(allocateDiscountToItems([{ price: 1, lineTotal: 1 }], 0, 100)).toEqual([0]);
  });
});

describe("getLedgerAgingBucket", () => {
  it("buckets overdue and not-due ranges", () => {
    const now = new Date("2026-09-27T04:30:00Z");
    const overdue3 = addDays(startOfDay(now), -3);
    expect(getLedgerAgingBucket(overdue3, now)).toBe("0-7");
    expect(getLedgerAgingBucket(addDays(startOfDay(now), -45), now)).toBe("30-60");
    expect(getLedgerAgingBucket(addDays(startOfDay(now), -90), now)).toBe("60+");
    expect(getLedgerAgingBucket(addDays(startOfDay(now), 3), now)).toBe("Not due (0-7d)");
    expect(getLedgerAgingBucket(addDays(startOfDay(now), 30), now)).toBe("Not due (15+d)");
  });
});
