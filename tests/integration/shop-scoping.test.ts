import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { testApp, login, authHeaders } from "../helpers/auth.js";
import { truncateAll, seedShop, closeTestPrisma, testPrisma } from "../helpers/db.js";

let app: ReturnType<typeof testApp>;

beforeAll(() => {
  app = testApp();
});
afterAll(async () => {
  await closeTestPrisma();
});
beforeEach(async () => {
  await truncateAll();
  await seedShop();
});

describe("shop scoping", () => {
  it("staff ?shopId=evil is ignored (still own shop)", async () => {
    const token = await login(app, "staff@test.local", "staffpass1");
    const res = await app.request("/api/products?shopId=other-shop&limit=5", { headers: authHeaders(token) });
    expect(res.status).toBe(200);
    const data = (await res.json()) as any;
    for (const p of data.products) expect(p.shopId).toBe("shop_test");
  });

  it("staff cannot read another shop's order", async () => {
    const owner = await login(app, "owner@test.local", "ownerpass1");
    // second shop + order
    const p = testPrisma();
    const shop2 = await p.shop.create({ data: { id: "shop_other", code: "GB-OTHER", name: "Other" } });
    await p.shopOrderSeq.create({ data: { shopId: shop2.id, lastNo: 0 } });
    const prod = await p.product.create({
      data: { id: "pother", shopId: shop2.id, name: "OP", category: "T", price: 10, costPrice: 7, stockQuantity: 10 } as any,
    });
    const order = await p.order.create({
      data: { orderNumber: "ORD-OTHER-1", shopId: shop2.id, total: 10, discount: 0, paymentMethod: "cash" as any, items: { create: [{ name: "OP", price: 10, unit: "pcs", quantity: 1, lineTotal: 10 }] } },
    });
    void prod;
    const staff = await login(app, "staff@test.local", "staffpass1");
    const res = await app.request(`/api/orders/${order.id}`, { headers: authHeaders(staff) });
    expect(res.status).toBe(403);
    void owner;
  });

  it("super can impersonate via x-shop-id", async () => {
    const p = testPrisma();
    const { hashPassword } = await import("../../src/lib/auth.js");
    await p.user.create({
      data: { email: "super2@test.local", name: "S", passwordHash: await hashPassword("superpass1"), role: "SUPER_ADMIN" as any, shopId: null },
    });
    const superToken = await login(app, "super2@test.local", "superpass1");
    const res = await app.request("/api/products?limit=2", {
      headers: { ...authHeaders(superToken), "x-shop-id": "shop_test" },
    });
    expect(res.status).toBe(200);
    expect(((await res.json()) as any).products.length).toBeGreaterThan(0);
  });
});
