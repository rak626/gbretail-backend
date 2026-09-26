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

function bill(productId: string, price: number, method = "cash", extra: Record<string, unknown> = {}) {
  return {
    items: [{ productId, name: "Test Prod 1", price, unit: "pcs", quantity: 1, lineTotal: price }],
    total: price,
    paymentMethod: method,
    ...extra,
  };
}

describe("orders", () => {
  it("creates cash order with per-shop sequential number", async () => {
    const token = await login(app, "owner@test.local", "ownerpass1");
    const mk = (key: string) =>
      app.request("/api/orders", {
        method: "POST",
        headers: authHeaders(token, { "Idempotency-Key": key }),
        body: JSON.stringify(bill("ptest1", 100)),
      });
    const r1 = await mk("ord-key-000001");
    expect(r1.status).toBe(201);
    const o1 = ((await r1.json()) as any).order;
    expect(o1.orderNumber).toMatch(/^ORD-\d{8}-[A-Z0-9]{4}-0001$/);
    const r2 = await mk("ord-key-000002");
    const o2 = ((await r2.json()) as any).order;
    expect(o2.orderNumber).toMatch(/-0002$/);
  });

  it("replays same idempotency key (no double bill)", async () => {
    const token = await login(app, "owner@test.local", "ownerpass1");
    const body = JSON.stringify(bill("ptest1", 100));
    const h = { "Idempotency-Key": "replay-key-12345" };
    const r1 = await app.request("/api/orders", { method: "POST", headers: authHeaders(token, h), body });
    const r2 = await app.request("/api/orders", { method: "POST", headers: authHeaders(token, h), body });
    const d1 = (await r1.json()) as any;
    const d2 = (await r2.json()) as any;
    expect(d1.order.id).toBe(d2.order.id);
    expect(d2.idempotentReplay).toBe(true);
    const count = await testPrisma().order.count({ where: { shopId: "shop_test", deletedAt: null } });
    expect(count).toBe(1);
  });

  it("rejects same key with different payload (422)", async () => {
    const token = await login(app, "owner@test.local", "ownerpass1");
    const h = { "Idempotency-Key": "reuse-key-99999" };
    await app.request("/api/orders", { method: "POST", headers: authHeaders(token, h), body: JSON.stringify(bill("ptest1", 100)) });
    const r2 = await app.request("/api/orders", { method: "POST", headers: authHeaders(token, h), body: JSON.stringify(bill("ptest2", 50)) });
    expect(r2.status).toBe(422);
  });

  it("rejects discount > total and bad split tender", async () => {
    const token = await login(app, "owner@test.local", "ownerpass1");
    const bad = await app.request("/api/orders", {
      method: "POST",
      headers: authHeaders(token),
      body: JSON.stringify({ ...bill("ptest1", 100), discount: 150 }),
    });
    expect(bad.status).toBe(400);
    const split = await app.request("/api/orders", {
      method: "POST",
      headers: authHeaders(token),
      body: JSON.stringify({ ...bill("ptest1", 100, "split", { splitCash: 60, splitUpi: 30 }), total: 100 }),
    });
    expect(split.status).toBe(400);
  });

  it("409 on insufficient stock and decrements on success", async () => {
    const token = await login(app, "owner@test.local", "ownerpass1");
    const big = await app.request("/api/orders", {
      method: "POST",
      headers: authHeaders(token),
      body: JSON.stringify({
        items: [{ productId: "ptest1", name: "T", price: 100, unit: "pcs", quantity: 500, lineTotal: 50000 }],
        total: 50000,
        paymentMethod: "cash",
      }),
    });
    expect(big.status).toBe(409);
    const before = await testPrisma().product.findUnique({ where: { id: "ptest1" } });
    await app.request("/api/orders", {
      method: "POST",
      headers: authHeaders(token),
      body: JSON.stringify(bill("ptest1", 100)),
    });
    const after = await testPrisma().product.findUnique({ where: { id: "ptest1" } });
    expect(Number((after as any).stockQuantity)).toBe(Number((before as any).stockQuantity) - 1);
  });

  it("void restores stock", async () => {
    const token = await login(app, "owner@test.local", "ownerpass1");
    const created = (await (
      await app.request("/api/orders", { method: "POST", headers: authHeaders(token), body: JSON.stringify(bill("ptest2", 50)) })
    ).json()) as any;
    const before = await testPrisma().product.findUnique({ where: { id: "ptest2" } });
    const del = await app.request(`/api/orders/${created.order.id}`, { method: "DELETE", headers: authHeaders(token) });
    expect(del.status).toBe(200);
    const after = await testPrisma().product.findUnique({ where: { id: "ptest2" } });
    expect(Number((after as any).stockQuantity)).toBe(Number((before as any).stockQuantity) + 1);
  });
});
