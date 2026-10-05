import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { testApp, login, authHeaders } from "../helpers/auth.js";
import { truncateAll, seedShop, closeTestPrisma, testPrisma, type Seed } from "../helpers/db.js";

let app: ReturnType<typeof testApp>;
let seed: Seed;

beforeAll(() => {
  app = testApp();
});
afterAll(async () => {
  await closeTestPrisma();
});
beforeEach(async () => {
  await truncateAll();
  seed = await seedShop();
  const p = testPrisma();
  await p.shop.update({ where: { id: "shop_test" }, data: { city: "TestCity", isOnlineEnabled: true } });
  await p.product.update({ where: { id: "ptest1" }, data: { isOnline: true } as any });
});

/** Register a global online account and place a pickup order (2 × ptest1 @ 100). */
async function placePickupOrder(phone = "9876543210", email = "pickup@online.test") {
  const reg = await app.request("/api/store/register", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: "Pickup Buyer", phone, email, password: "buyerpass1" }),
  });
  expect(reg.status).toBe(201);
  const token = ((await reg.json()) as any).accessToken as string;
  const orderRes = await app.request("/api/store/orders", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify({ shopId: "shop_test", items: [{ productId: "ptest1", qty: 2 }], fulfilment: "pickup" }),
  });
  expect(orderRes.status).toBe(201);
  return { order: ((await orderRes.json()) as any).order, token };
}

describe("counter settlement (online pickup → paid at POS)", () => {
  it("staff settles pending order with cash: delivered, no second sale", async () => {
    const { order } = await placePickupOrder();
    const p = testPrisma();
    const stockBefore = Number((await p.product.findUnique({ where: { id: "ptest1" } }))!.stockQuantity);
    const custBefore = await p.customer.findFirst({ where: { phone: "9876543210" } });

    const staff = await login(app, "staff@test.local", "staffpass1");
    const res = await app.request(`/api/orders/${order.id}/settle`, {
      method: "POST",
      headers: authHeaders(staff),
      body: JSON.stringify({ paymentMethod: "cash" }),
    });
    expect(res.status).toBe(200);
    const settled = ((await res.json()) as any).order;
    expect(settled.status).toBe("delivered");
    expect(settled.paymentMethod).toBe("cash");
    expect(settled.channel).toBe("online");
    expect(Number(settled.total)).toBe(200);
    // STAFF pinned to assigned counter, attributed to staffer
    expect(settled.counterId).toBe(seed.counterId);
    expect(settled.userId).toBe(seed.staffId);

    // No stock movement, no customer aggregate change — sale was booked at creation
    expect(Number((await p.product.findUnique({ where: { id: "ptest1" } }))!.stockQuantity)).toBe(stockBefore);
    const custAfter = await p.customer.findFirst({ where: { phone: "9876543210" } });
    expect(custAfter!.totalOrders).toBe(custBefore!.totalOrders);
    expect(Number(custAfter!.totalSpent)).toBe(Number(custBefore!.totalSpent));

    // Still exactly one order row — no duplicate bill
    expect(await p.order.count({ where: { shopId: "shop_test" } })).toBe(1);
  });

  it("owner settles with split tender; mismatch rejected", async () => {
    const { order } = await placePickupOrder("9876543211", "split@online.test");
    const owner = await login(app, "owner@test.local", "ownerpass1");

    const bad = await app.request(`/api/orders/${order.id}/settle`, {
      method: "POST",
      headers: authHeaders(owner),
      body: JSON.stringify({ paymentMethod: "split", counterId: seed.counterId, splitCash: 150, splitUpi: 40 }),
    });
    expect(bad.status).toBe(400);

    const good = await app.request(`/api/orders/${order.id}/settle`, {
      method: "POST",
      headers: authHeaders(owner),
      body: JSON.stringify({ paymentMethod: "split", counterId: seed.counterId, splitCash: 150, splitUpi: 50 }),
    });
    expect(good.status).toBe(200);
    const settled = ((await good.json()) as any).order;
    expect(settled.status).toBe("delivered");
    expect(settled.paymentMethod).toBe("split");
    expect(Number(settled.cashAmount)).toBe(150);
    expect(Number(settled.upiAmount)).toBe(50);
    expect(settled.counterId).toBe(seed.counterId);
    expect(settled.userId).toBe(seed.ownerId);
  });

  it("rejects khata on pickup collection", async () => {
    const { order } = await placePickupOrder("9876543212", "khata@online.test");
    const staff = await login(app, "staff@test.local", "staffpass1");
    const res = await app.request(`/api/orders/${order.id}/settle`, {
      method: "POST",
      headers: authHeaders(staff),
      body: JSON.stringify({ paymentMethod: "khata" }),
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as any).code).toBe("KHATA_NOT_ALLOWED");
  });

  it("second settle conflicts; cancelled order cannot be settled", async () => {
    const { order, token } = await placePickupOrder("9876543213", "twice@online.test");
    const staff = await login(app, "staff@test.local", "staffpass1");

    const first = await app.request(`/api/orders/${order.id}/settle`, {
      method: "POST",
      headers: authHeaders(staff),
      body: JSON.stringify({ paymentMethod: "upi" }),
    });
    expect(first.status).toBe(200);

    const second = await app.request(`/api/orders/${order.id}/settle`, {
      method: "POST",
      headers: authHeaders(staff),
      body: JSON.stringify({ paymentMethod: "upi" }),
    });
    expect(second.status).toBe(409);
    expect(((await second.json()) as any).code).toBe("NOT_SETTLABLE");

    // Customer cancels a fresh pending order, then counter tries to settle it
    const fresh = await placePickupOrder("9876543214", "cancel@online.test");
    const cancel = await app.request(`/api/store/orders/${fresh.order.id}/cancel`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${fresh.token}` },
    });
    expect(cancel.status).toBe(200);
    const late = await app.request(`/api/orders/${fresh.order.id}/settle`, {
      method: "POST",
      headers: authHeaders(staff),
      body: JSON.stringify({ paymentMethod: "cash" }),
    });
    expect(late.status).toBe(409);
    expect(token).toBeTruthy();
  });

  it("rejects POS-channel orders and settles from confirmed/packed", async () => {
    const staff = await login(app, "staff@test.local", "staffpass1");
    // A regular counter sale cannot go through settle
    const sale = await app.request("/api/orders", {
      method: "POST",
      headers: authHeaders(staff),
      body: JSON.stringify({
        items: [{ productId: "ptest1", name: "Test Prod 1", price: 100, quantity: 1, lineTotal: 100 }],
        paymentMethod: "cash",
      }),
    });
    expect(sale.status).toBe(201);
    const saleId = ((await sale.json()) as any).order.id;
    const notOnline = await app.request(`/api/orders/${saleId}/settle`, {
      method: "POST",
      headers: authHeaders(staff),
      body: JSON.stringify({ paymentMethod: "cash" }),
    });
    expect(notOnline.status).toBe(400);
    expect(((await notOnline.json()) as any).code).toBe("NOT_ONLINE");

    // confirmed → packed → settle all stay valid
    const { order } = await placePickupOrder("9876543215", "flow@online.test");
    for (const s of ["confirmed", "packed"]) {
      const mv = await app.request(`/api/orders/${order.id}/status`, {
        method: "PATCH",
        headers: authHeaders(staff),
        body: JSON.stringify({ status: s }),
      });
      expect(mv.status).toBe(200);
    }
    const done = await app.request(`/api/orders/${order.id}/settle`, {
      method: "POST",
      headers: authHeaders(staff),
      body: JSON.stringify({ paymentMethod: "cash" }),
    });
    expect(done.status).toBe(200);
    expect(((await done.json()) as any).order.status).toBe("delivered");
  });
});
