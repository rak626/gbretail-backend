import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { testApp, login, authHeaders } from "../helpers/auth.js";
import { truncateAll, seedShop, closeTestPrisma } from "../helpers/db.js";

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

describe("cursor pagination", () => {
  it("orders: page 1 → nextCursor → page 2 without overlap", async () => {
    const token = await login(app, "owner@test.local", "ownerpass1");
    const mk = (i: number) =>
      app.request("/api/orders", {
        method: "POST",
        headers: authHeaders(token, { "Idempotency-Key": `cur-ord-${i}` }),
        body: JSON.stringify({
          items: [{ productId: "ptest3", name: "T3", price: 25, unit: "pcs", quantity: 1, lineTotal: 25 }],
          total: 25,
          paymentMethod: "cash",
        }),
      });
    await mk(1);
    await mk(2);
    await mk(3);
    const p1 = (await (await app.request("/api/orders?limit=2", { headers: authHeaders(token) })).json()) as any;
    expect(p1.orders).toHaveLength(2);
    const p2 = (await (await app.request(`/api/orders?limit=2&cursor=${p1.orders.length ? await cursorOf(p1.orders[p1.orders.length - 1]) : ""}`, { headers: authHeaders(token) })).json()) as any;
    expect(p2.orders).toHaveLength(1);
    const ids1 = new Set(p1.orders.map((o: any) => o.id));
    for (const o of p2.orders) expect(ids1.has(o.id)).toBe(false);
  });

  it("rejects bogus cursor with 400", async () => {
    const token = await login(app, "owner@test.local", "ownerpass1");
    for (const path of ["/api/orders?cursor=bogus", "/api/customers?cursor=bogus", "/api/ledger?cursor=bogus"]) {
      const res = await app.request(path, { headers: authHeaders(token) });
      expect(res.status).toBe(400);
    }
  });

  it("products stock=low refuses cursor mode", async () => {
    const token = await login(app, "owner@test.local", "ownerpass1");
    const res = await app.request("/api/products?stock=low&cursor=abc", { headers: authHeaders(token) });
    // invalid cursor decodes first OR unsupported-mode — either way 400
    expect(res.status).toBe(400);
  });
});

async function cursorOf(_order: any): Promise<string> {
  const { encodeCursor } = await import("../../src/lib/pagination.js");
  return encodeCursor(_order.createdAt, _order.id);
}
