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

describe("products batch + cost guard", () => {
  it("imports 2 rows in one request", async () => {
    const token = await login(app, "owner@test.local", "ownerpass1");
    const res = await app.request("/api/products/batch", {
      method: "POST",
      headers: authHeaders(token),
      body: JSON.stringify({
        items: [
          { name: "Batch 1", category: "Test", is_loose: false, price: 10, costPrice: 7, stockQuantity: 50 },
          { name: "Batch 2", category: "Test", is_loose: false, price: 20, costPrice: 14, stockQuantity: 30 },
        ],
      }),
    });
    expect(res.status).toBe(201);
    expect(((await res.json()) as any).count).toBe(2);
  });

  it("rejects >500 rows and writes nothing on validation failure", async () => {
    const token = await login(app, "owner@test.local", "ownerpass1");
    const big = await app.request("/api/products/batch", {
      method: "POST",
      headers: authHeaders(token),
      body: JSON.stringify({ items: Array.from({ length: 501 }, (_, i) => ({ name: `P${i}`, category: "T", is_loose: false, price: 1, costPrice: 1 })) }),
    });
    expect(big.status).toBe(400);
    const bad = await app.request("/api/products/batch", {
      method: "POST",
      headers: authHeaders(token),
      body: JSON.stringify({ items: [{ name: "", category: "T", is_loose: false, price: 1, costPrice: 1 }] }),
    });
    expect(bad.status).toBe(400);
    expect(((await bad.json()) as any).errors).toHaveLength(1);
  });

  it("409 on duplicate active barcode (batch + single)", async () => {
    const token = await login(app, "owner@test.local", "ownerpass1");
    const mk = (barcode: string) => ({ name: `B-${barcode}`, category: "T", is_loose: false, price: 5, costPrice: 3, barcode });
    const r1 = await app.request("/api/products/batch", {
      method: "POST",
      headers: authHeaders(token),
      body: JSON.stringify({ items: [mk("BATCHDUP1")] }),
    });
    expect(r1.status).toBe(201);
    const r2 = await app.request("/api/products/batch", {
      method: "POST",
      headers: authHeaders(token),
      body: JSON.stringify({ items: [mk("BATCHDUP1")] }),
    });
    expect(r2.status).toBe(409);
  });

  it("staff without grant cannot mutate; cannot see costPrice", async () => {
    const staff = await login(app, "staff@test.local", "staffpass1");
    const denied = await app.request("/api/products/batch", {
      method: "POST",
      headers: authHeaders(staff),
      body: JSON.stringify({ items: [{ name: "X", category: "T", is_loose: false, price: 1, costPrice: 1 }] }),
    });
    expect(denied.status).toBe(403);
    const list = await app.request("/api/products?limit=1", { headers: authHeaders(staff) });
    const p = (((await list.json()) as any).products as any[])[0];
    expect(p).not.toHaveProperty("costPrice");
    const meta = (await (await app.request("/api/products/meta", { headers: authHeaders(staff) })).json()) as any;
    expect(meta.stockValueCost).toBe(0);
  });

  it("owner sees costPrice", async () => {
    const token = await login(app, "owner@test.local", "ownerpass1");
    const list = await app.request("/api/products?limit=1", { headers: authHeaders(token) });
    expect((((await list.json()) as any).products as any[])[0]).toHaveProperty("costPrice");
  });
});
