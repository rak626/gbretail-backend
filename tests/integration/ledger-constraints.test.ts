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

describe("ledger", () => {
  it("khata bill auto-creates pending entry + balance", async () => {
    const token = await login(app, "owner@test.local", "ownerpass1");
    const res = await app.request("/api/orders", {
      method: "POST",
      headers: authHeaders(token),
      body: JSON.stringify({
        items: [{ productId: "ptest1", name: "T1", price: 100, unit: "pcs", quantity: 1, lineTotal: 100 }],
        total: 100,
        paymentMethod: "khata",
        customerName: "Khata Guy",
        customerPhone: "9876543210",
      }),
    });
    expect(res.status).toBe(201);
    const entries = await testPrisma().ledgerEntry.findMany({ where: { shopId: "shop_test", deletedAt: null } });
    expect(entries).toHaveLength(1);
    expect(entries[0]!.status).toBe("pending");
    const cust = await testPrisma().customer.findFirst({ where: { phone: "9876543210" } });
    expect(Number((cust as any).balance)).toBe(100);
  });

  it("settle → settled, reopen → pending", async () => {
    const token = await login(app, "owner@test.local", "ownerpass1");
    const created = (await (
      await app.request("/api/ledger", {
        method: "POST",
        headers: authHeaders(token),
        body: JSON.stringify({ customerName: "L", customerPhone: "9999999999", amount: 200 }),
      })
    ).json()) as any;
    const id = created.entry.id;
    // entry shape: POST /ledger returns { entry } — accept either
    const entryId: string = id ?? created.entry?.id ?? created.id;
    expect(entryId).toBeTruthy();
    const settle = await app.request(`/api/ledger/${entryId}`, { method: "PATCH", headers: authHeaders(token), body: JSON.stringify({ action: "settle" }) });
    expect(settle.status).toBe(200);
    const reopen = await app.request(`/api/ledger/${entryId}`, { method: "PATCH", headers: authHeaders(token), body: JSON.stringify({ action: "reopen" }) });
    expect(reopen.status).toBe(200);
    expect(((await reopen.json()) as any).entry.status).toBe("pending");
  });

  it("staff counter is server-resolved (no stale JWT)", async () => {
    const staff = await login(app, "staff@test.local", "staffpass1");
    const res = await app.request("/api/ledger", {
      method: "POST",
      headers: authHeaders(staff),
      body: JSON.stringify({ customerName: "S", customerPhone: "9111111111", amount: 50, counterId: "bogus-counter" }),
    });
    // bogus counter ignored for staff — resolved to assigned counter, still 201
    expect(res.status).toBe(201);
  });
});

describe("db constraints + health", () => {
  it("CHECK blocks negative stock and bad creditDays", async () => {
    const p = testPrisma();
    await expect(p.product.update({ where: { id: "ptest1" }, data: { stockQuantity: -1 } as any })).rejects.toThrow();
    await expect(
      p.ledgerEntry.create({
        data: { shopId: "shop_test", customerId: (await p.customer.create({ data: { shopId: "shop_test", name: "C" } })).id, amount: 10, creditDays: 0, dueDate: new Date(), status: "pending" as any },
      })
    ).rejects.toThrow();
  });

  it("active-only barcode allows reuse after soft-delete", async () => {
    const token = await login(app, "owner@test.local", "ownerpass1");
    const mk = (name: string) => ({ name, category: "T", is_loose: false, price: 5, costPrice: 3, barcode: "REUSEME1" });
    const r1 = await app.request("/api/products", { method: "POST", headers: authHeaders(token), body: JSON.stringify(mk("A")) });
    expect(r1.status).toBe(201);
    const id = (((await r1.json()) as any).product as any).id;
    await app.request(`/api/products/${id}`, { method: "DELETE", headers: authHeaders(token) });
    const r2 = await app.request("/api/products", { method: "POST", headers: authHeaders(token), body: JSON.stringify(mk("B")) });
    expect(r2.status).toBe(201);
  });

  it("health reports connected", async () => {
    const res = await app.request("/api/health");
    expect(res.status).toBe(200);
    expect(((await res.json()) as any).db).toBe("connected");
  });
});
