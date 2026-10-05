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
  const p = testPrisma();
  await p.shop.update({ where: { id: "shop_test" }, data: { city: "TestCity", isOnlineEnabled: true } });
  await p.product.update({ where: { id: "ptest1" }, data: { isOnline: true, onlinePrice: 120 } as any });
});

async function registerGlobal(
  overrides: Record<string, string> = {},
  phone = "9876543210",
  email = "buyer@online.test"
) {
  const res = await app.request("/api/store/register", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: "Online Buyer", phone, email, password: "buyerpass1", ...overrides }),
  });
  return res;
}

describe("storefront (global online identity on core backend)", () => {
  it("lists cities + shops + online products publicly, never leaks costPrice", async () => {
    const cities = await (await app.request("/api/store/cities")).json() as any;
    expect(cities.cities.map((c: any) => c.city)).toContain("TestCity");
    const shops = await (await app.request("/api/store/shops?city=TestCity")).json() as any;
    expect(shops.shops.length).toBe(1);
    expect(shops.shops[0].id).toBe("shop_test");
    const prods = await (await app.request("/api/store/shops/shop_test/products")).json() as any;
    expect(prods.total).toBe(1);
    expect(prods.products[0].id).toBe("ptest1");
    expect(prods.products[0].effectivePrice).toBe(120);
    expect(prods.products[0].costPrice).toBeUndefined();
  });

  it("register needs no shop; login works by email or phone; me returns the user", async () => {
    const reg = await registerGlobal();
    expect(reg.status).toBe(201);
    const regData = (await reg.json()) as any;
    expect(regData.user.email).toBe("buyer@online.test");
    expect(regData.user).not.toHaveProperty("shopId");
    expect(regData).not.toHaveProperty("shop");

    for (const identifier of ["buyer@online.test", "9876543210"]) {
      const loginRes = await app.request("/api/store/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: identifier, password: "buyerpass1" }),
      });
      expect(loginRes.status).toBe(200);
      expect(((await loginRes.json()) as any).user.id).toBe(regData.user.id);
    }

    const me = await app.request("/api/store/me", {
      headers: { Authorization: `Bearer ${regData.accessToken}` },
    });
    expect(me.status).toBe(200);
    expect(((await me.json()) as any).user.phone).toBe("9876543210");

    // Wrong password + unknown user stay 401
    const bad = await app.request("/api/store/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "buyer@online.test", password: "wrongpass1" }),
    });
    expect(bad.status).toBe(401);
  });

  it("phone and email are globally unique", async () => {
    expect((await registerGlobal()).status).toBe(201);
    const dupPhone = await registerGlobal({ email: "other@online.test" }, "9876543210", "other@online.test");
    expect(dupPhone.status).toBe(409);
    expect(((await dupPhone.json()) as any).code).toBe("PHONE_TAKEN");
    const dupEmail = await registerGlobal({}, "9876543211", "buyer@online.test");
    expect(dupEmail.status).toBe(409);
    expect(((await dupEmail.json()) as any).code).toBe("EMAIL_TAKEN");
  });

  it("order takes shopId from the cart and links the shop POS row by phone", async () => {
    const p = testPrisma();
    // POS-side customer already exists in this shop (walk-in history)
    await p.customer.create({ data: { shopId: "shop_test", name: "POS Regular", phone: "9876543210", balance: 0 } });

    const reg = await registerGlobal();
    expect(reg.status).toBe(201);
    const token = (((await reg.json()) as any).accessToken as string);
    expect(token).toBeTruthy();

    const orderRes = await app.request("/api/store/orders", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}`, "Idempotency-Key": "web-test-1" },
      body: JSON.stringify({ shopId: "shop_test", items: [{ productId: "ptest1", qty: 2 }], fulfilment: "pickup" }),
    });
    expect(orderRes.status).toBe(201);
    const order = ((await orderRes.json()) as any).order;
    expect(order.channel).toBe("online");
    expect(order.status).toBe("pending");
    expect(Number(order.total)).toBe(240);
    expect(order.onlineUserId).toBeTruthy();

    // Attached to the pre-existing POS row — no duplicate customer created
    const rows = await p.customer.findMany({ where: { shopId: "shop_test", phone: "9876543210" } });
    expect(rows.length).toBe(1);
    expect(order.customerId).toBe(rows[0]!.id);

    // Shared inventory: 100 → 98
    const prod = await p.product.findUnique({ where: { id: "ptest1" } });
    expect(Number((prod as any).stockQuantity)).toBe(98);

    // POS sees the online order
    const staff = await login(app, "staff@test.local", "staffpass1");
    const ordersRes = await app.request("/api/orders?channel=online", { headers: authHeaders(staff) });
    expect(((await ordersRes.json()) as any).orders.length).toBe(1);
  });

  it("one account orders from two shops; myOrders spans both", async () => {
    const p = testPrisma();
    await p.shop.create({ data: { id: "shop_two", code: "GB-TEST-2", name: "Second Shop", isOnlineEnabled: true } });
    await p.product.create({
      data: { id: "p2online", shopId: "shop_two", name: "Second Prod", category: "Test", price: 50, costPrice: 30, stockQuantity: 100, lowStockThreshold: 5, isOnline: true } as any,
    });
    const reg = await registerGlobal({}, "9876543220", "two@online.test");
    const token = ((await reg.json()) as any).accessToken as string;
    const auth = { "Content-Type": "application/json", Authorization: `Bearer ${token}` };

    for (const [shopId, productId, qty] of [["shop_test", "ptest1", 1], ["shop_two", "p2online", 2]] as const) {
      const r = await app.request("/api/store/orders", {
        method: "POST",
        headers: auth,
        body: JSON.stringify({ shopId, items: [{ productId, qty }], fulfilment: "pickup" }),
      });
      expect(r.status).toBe(201);
    }
    const mine = await app.request("/api/store/orders/mine", { headers: { Authorization: `Bearer ${token}` } });
    const orders = ((await mine.json()) as any).orders;
    expect(orders.length).toBe(2);
    expect(orders.map((o: any) => o.shop?.name).sort()).toEqual(["Second Shop", "Test Shop"]);

    // Per-shop POS rows linked by the same phone
    for (const shopId of ["shop_test", "shop_two"]) {
      expect(await p.customer.count({ where: { shopId, phone: "9876543220" } })).toBe(1);
    }
  });

  it("rejects missing shop, foreign products, offline products, min order", async () => {
    const regEdge = await registerGlobal({}, "9876543230", "edge@online.test");
    expect(regEdge.status).toBe(201);
    const token = (((await regEdge.json()) as any).accessToken as string);
    const auth = (body: unknown, key?: string) =>
      app.request("/api/store/orders", {
        method: "POST",
        headers: key
          ? { "Content-Type": "application/json", Authorization: `Bearer ${token}`, "Idempotency-Key": key }
          : { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify(body),
      });

    // No shopId in a global account's request
    const noShop = await auth({ items: [{ productId: "ptest1", qty: 1 }], fulfilment: "pickup" });
    expect(noShop.status).toBe(400);
    expect(((await noShop.json()) as any).code).toBe("SHOP_REQUIRED");

    // ptest2 is not online
    const bad = await auth({ shopId: "shop_test", items: [{ productId: "ptest2", qty: 1 }], fulfilment: "pickup" });
    expect(bad.status).toBe(409);

    // Min order enforced per shop
    const p = testPrisma();
    await p.shop.update({ where: { id: "shop_test" }, data: { minOrderAmount: 1000 } });
    const min = await auth({ shopId: "shop_test", items: [{ productId: "ptest1", qty: 1 }], fulfilment: "pickup" });
    expect(min.status).toBe(422);
  });

  it("cancel is owner-only; staff can still confirm the flow", async () => {
    const regA = await registerGlobal({}, "9876543240", "a@online.test");
    const tokenA = ((await regA.json()) as any).accessToken as string;
    const regB = await registerGlobal({}, "9876543241", "b@online.test");
    const tokenB = ((await regB.json()) as any).accessToken as string;

    const created = await app.request("/api/store/orders", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${tokenA}` },
      body: JSON.stringify({ shopId: "shop_test", items: [{ productId: "ptest1", qty: 1 }], fulfilment: "pickup" }),
    });
    const orderId = ((await created.json()) as any).order.id;

    const other = await app.request(`/api/store/orders/${orderId}/cancel`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${tokenB}` },
    });
    expect(other.status).toBe(403);

    const mine = await app.request(`/api/store/orders/${orderId}/cancel`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${tokenA}` },
    });
    expect(mine.status).toBe(200);
    expect(((await mine.json()) as any).order.status).toBe("cancelled");

    // Stock restored by cancel
    const prod = await testPrisma().product.findUnique({ where: { id: "ptest1" } });
    expect(Number((prod as any).stockQuantity)).toBe(100);

    // Staff confirms another fresh order through the status flow
    const fresh = await app.request("/api/store/orders", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${tokenA}` },
      body: JSON.stringify({ shopId: "shop_test", items: [{ productId: "ptest1", qty: 1 }], fulfilment: "pickup" }),
    });
    const freshId = ((await fresh.json()) as any).order.id;
    const staff = await login(app, "staff@test.local", "staffpass1");
    const st = await app.request(`/api/orders/${freshId}/status`, {
      method: "PATCH",
      headers: authHeaders(staff),
      body: JSON.stringify({ status: "confirmed" }),
    });
    expect(st.status).toBe(200);
  });
});
