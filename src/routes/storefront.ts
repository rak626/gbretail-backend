// Public storefront API — online customer frontend talks to the same core backend.
// POS (staff) uses authed /api/*; online customers use these public /api/store/* routes.
// Same tables (Shop/Product/Customer/Order), so POS sees online customers/orders automatically.
// - Catalog never leaks costPrice.
// - Prices are resolved server-side from onlinePrice ?? price/rate_per_kg.
// - Customer auth is email/phone + password on the shared Customer row (passwordHash NULL = POS-only).
import { Hono } from "hono";
import { setCookie, getCookie, deleteCookie } from "hono/cookie";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import { prisma } from "../lib/prisma.js";
import { config } from "../config.js";
import { normalizePhone, normalizeEmail } from "../lib/normalize.js";
import { round2, parseMoney, dec, MAX_MONEY } from "../lib/money.js";
import { toAppError, AppError } from "../lib/errors.js";
import { getIdempotencyKey, isValidIdempotencyKey, fingerprint } from "../lib/idempotency.js";

const store = new Hono();

// Global online identity — one account across all shops (fresh start: legacy
// per-shop Customer logins were retired; old CUSTOMER tokens fail closed here).
type OnlineUserJwt = { onlineUserId: string; role: "ONLINE_USER"; email: string | null; name: string };

function signOnlineToken(p: OnlineUserJwt): string {
  return jwt.sign(p as object, config.jwtAccessSecret, { expiresIn: "7d" } as jwt.SignOptions);
}

function getCustomerToken(c: any): string | null {
  const h = c.req.header("authorization") || c.req.header("Authorization") || "";
  if (h) {
    const parts = h.split(" ");
    if (parts.length === 2 && parts[0].toLowerCase() === "bearer") return parts[1];
  }
  try {
    const fromCookie = getCookie(c, "customerToken");
    if (fromCookie) return fromCookie;
  } catch { /* ignore */ }
  return null;
}

function sanitizeOnlineUser(r: any) {
  return { id: r.id, name: r.name, phone: r.phone, email: r.email, address: r.address ?? null };
}

async function requireCustomerAuth(c: any, next: any) {
  const token = getCustomerToken(c);
  if (!token) return c.json({ error: "Login required", code: "UNAUTHORIZED" }, 401);
  try {
    const p = jwt.verify(token, config.jwtAccessSecret) as any;
    if (!p?.onlineUserId || p?.role !== "ONLINE_USER") throw new Error("bad payload");
    const row: any = await prisma.onlineUser.findUnique({ where: { id: p.onlineUserId } });
    if (!row) return c.json({ error: "Account not found", code: "ACCOUNT_DISABLED" }, 401);
    c.set("customer", { id: row.id, email: row.email, name: row.name, phone: row.phone, address: row.address ?? null });
    await next();
  } catch (e) {
    const msg = e instanceof Error ? e.message : "";
    if (msg.includes("expired")) return c.json({ error: "Session expired — login again", code: "TOKEN_EXPIRED" }, 401);
    return c.json({ error: "Invalid session — login again", code: "UNAUTHORIZED" }, 401);
  }
}

async function hashPw(plain: string): Promise<string> {
  const salt = await bcrypt.genSalt(config.bcryptRounds);
  return bcrypt.hash(plain, salt);
}

function publicShop(s: any) {
  return {
    id: s.id, code: s.code, name: s.name, address: s.address, city: s.city,
    phone: s.phone, email: s.email ?? null, pickupEnabled: s.pickupEnabled, deliveryEnabled: s.deliveryEnabled,
    codEnabled: s.codEnabled, deliveryFee: dec(s.deliveryFee), freeDeliveryAbove: s.freeDeliveryAbove != null ? dec(s.freeDeliveryAbove) : null,
    minOrderAmount: dec(s.minOrderAmount), onlineNote: s.onlineNote, avgPrepMinutes: s.avgPrepMinutes ?? null,
  };
}

function effectivePrice(p: any): number {
  const online = p.onlinePrice != null ? dec(p.onlinePrice) : NaN;
  if (!isNaN(online) && online >= 0) return round2(online);
  if (p.price != null) return round2(dec(p.price));
  if (p.rate_per_kg != null) return round2(dec(p.rate_per_kg));
  return NaN;
}

function publicProduct(p: any) {
  const { costPrice: _omit, ...rest } = p;
  return { ...rest, effectivePrice: effectivePrice(p) };
}

async function ensureOnlineShop(shopId: string) {
  const shop: any = await prisma.shop.findUnique({ where: { id: shopId } });
  if (!shop || shop.deletedAt || !shop.isActive) throw new AppError(404, "Shop not found");
  if (!shop.isOnlineEnabled) throw new AppError(403, "Online ordering is disabled for this shop", "ONLINE_DISABLED");
  return shop;
}

// GET /api/store/cities — distinct cities with online-enabled shops
store.get("/cities", async (c) => {
  try {
    const rows = await prisma.shop.findMany({
      where: { deletedAt: null, isActive: true, isOnlineEnabled: true },
      select: { city: true },
    });
    const set = new Map<string, number>();
    for (const r of rows) {
      const city = (r.city ?? "").trim();
      if (!city) continue;
      set.set(city, (set.get(city) ?? 0) + 1);
    }
    const cities = [...set.entries()].map(([city, shops]) => ({ city, shops })).sort((a, b) => a.city.localeCompare(b.city));
    return c.json({ cities });
  } catch (e) {
    const appErr = toAppError(e);
    return c.json({ error: appErr.message, code: appErr.code }, 500);
  }
});

// GET /api/store/shops?city=
store.get("/shops", async (c) => {
  try {
    const city = (c.req.query("city") ?? "").trim();
    const where: any = { deletedAt: null, isActive: true, isOnlineEnabled: true };
    if (city) where.city = { equals: city, mode: "insensitive" };
    const shops = await prisma.shop.findMany({ where, orderBy: { name: "asc" }, take: 100 });
    return c.json({ shops: shops.map(publicShop) });
  } catch (e) {
    const appErr = toAppError(e);
    return c.json({ error: appErr.message, code: appErr.code }, 500);
  }
});

// GET /api/store/shops/:id
store.get("/shops/:id", async (c) => {
  try {
    const shop: any = await prisma.shop.findUnique({ where: { id: c.req.param("id") } });
    if (!shop || shop.deletedAt || !shop.isActive) return c.json({ error: "Shop not found" }, 404);
    if (!shop.isOnlineEnabled) return c.json({ error: "Online ordering is disabled for this shop", code: "ONLINE_DISABLED" }, 403);
    const cats = await prisma.product.findMany({
      where: { shopId: shop.id, deletedAt: null, isOnline: true } as any,
      select: { category: true }, distinct: ["category"], orderBy: { category: "asc" },
    });
    return c.json({ shop: publicShop(shop), categories: cats.map((r: any) => r.category) });
  } catch (e) {
    const appErr = toAppError(e);
    return c.json({ error: appErr.message, code: appErr.code }, 500);
  }
});

// GET /api/store/shops/:id/products?search&category&limit&page
store.get("/shops/:id/products", async (c) => {
  try {
    const shopId = c.req.param("id");
    await ensureOnlineShop(shopId);
    const search = (c.req.query("search") ?? "").trim();
    const category = c.req.query("category") ?? "All";
    const limit = Math.min(Math.max(parseInt(c.req.query("limit") ?? "60", 10) || 60, 1), 100);
    const page = Math.max(parseInt(c.req.query("page") ?? "1", 10) || 1, 1);
    const where: any = { shopId, deletedAt: null, isOnline: true, stockQuantity: { gt: 0 } };
    if (search) where.OR = [{ name: { contains: search, mode: "insensitive" } }, { barcode: { contains: search, mode: "insensitive" } }];
    if (category && category !== "All") {
      if (category === "Loose Items") where.is_loose = true;
      else where.category = category;
    }
    const [items, total] = await Promise.all([
      prisma.product.findMany({ where, orderBy: { name: "asc" }, take: limit, skip: (page - 1) * limit }),
      prisma.product.count({ where }),
    ]);
    return c.json({ products: (items as any[]).map(publicProduct), total, page, limit });
  } catch (e) {
    if (e instanceof AppError) return c.json({ error: e.message, code: e.code }, e.status as 403 | 404);
    const appErr = toAppError(e);
    return c.json({ error: appErr.message, code: appErr.code }, 500);
  }
});

// POST /api/store/register {name,phone,email,password,address?} — global account, no shop.
store.post("/register", async (c) => {
  try {
    const body: any = await c.req.json();
    const name = String(body.name ?? "").trim().slice(0, 80);
    const phone = normalizePhone(body.phone);
    const email = normalizeEmail(body.email);
    const address = body.address ? String(body.address).trim().slice(0, 500) : null;
    const password = String(body.password ?? "");
    if (!name) return c.json({ error: "Name required" }, 400);
    if (!phone || !/^\d{10}$/.test(phone)) return c.json({ error: "Valid 10-digit phone required" }, 400);
    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return c.json({ error: "Valid email required" }, 400);
    if (password.length < 6 || password.length > 100) return c.json({ error: "Password must be 6-100 chars" }, 400);

    const phoneTaken: any = await prisma.onlineUser.findUnique({ where: { phone } });
    if (phoneTaken) return c.json({ error: "Phone already registered — login instead", code: "PHONE_TAKEN" }, 409);
    const emailTaken: any = await prisma.onlineUser.findUnique({ where: { email } });
    if (emailTaken) return c.json({ error: "Email already registered — login instead", code: "EMAIL_TAKEN" }, 409);
    const created: any = await prisma.onlineUser.create({
      data: { name, phone, email, address, passwordHash: await hashPw(password) },
    });
    const token = signOnlineToken({ onlineUserId: created.id, role: "ONLINE_USER", email: created.email, name: created.name });
    setCookie(c, "customerToken", token, { httpOnly: true, secure: config.isProduction, sameSite: "Lax", path: "/", maxAge: 7 * 24 * 60 * 60 });
    return c.json({ accessToken: token, user: sanitizeOnlineUser(created) }, 201);
  } catch (e) {
    if (e instanceof AppError) return c.json({ error: e.message, code: e.code }, e.status as 400 | 403 | 404 | 409);
    const appErr = toAppError(e);
    return c.json({ error: appErr.message, code: appErr.code }, 500);
  }
});

// POST /api/store/login {email|phone, password} — global lookup, no shop.
store.post("/login", async (c) => {
  try {
    const body: any = await c.req.json();
    const password = String(body.password ?? "");
    if (!password) return c.json({ error: "Password required" }, 400);
    const email = normalizeEmail(body.email);
    const phone = normalizePhone(body.phone ?? body.email);
    let row: any = null;
    if (email && email.includes("@")) row = await prisma.onlineUser.findUnique({ where: { email } });
    if (!row && phone) row = await prisma.onlineUser.findUnique({ where: { phone } });
    if (!row) return c.json({ error: "Invalid credentials" }, 401);
    const ok = await bcrypt.compare(password, row.passwordHash);
    if (!ok) return c.json({ error: "Invalid credentials" }, 401);
    const token = signOnlineToken({ onlineUserId: row.id, role: "ONLINE_USER", email: row.email, name: row.name });
    setCookie(c, "customerToken", token, { httpOnly: true, secure: config.isProduction, sameSite: "Lax", path: "/", maxAge: 7 * 24 * 60 * 60 });
    return c.json({ accessToken: token, user: sanitizeOnlineUser(row) });
  } catch (e) {
    if (e instanceof AppError) return c.json({ error: e.message, code: e.code }, e.status as 400 | 403 | 404);
    const appErr = toAppError(e);
    return c.json({ error: appErr.message, code: appErr.code }, 500);
  }
});

store.post("/logout", async (c) => {
  deleteCookie(c, "customerToken", { path: "/" });
  return c.json({ success: true });
});

store.get("/me", requireCustomerAuth as any, async (c) => {
  const cust: any = (c as any).get("customer");
  const row: any = await prisma.onlineUser.findUnique({ where: { id: cust.id } });
  if (!row) return c.json({ error: "Not found" }, 404);
  return c.json({ user: sanitizeOnlineUser(row) });
});

function istDateParts(d = new Date()): { yyyy: string; mm: string; dd: string } {
  const fmt = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata", year: "numeric", month: "2-digit", day: "2-digit" });
  const parts = fmt.formatToParts(d);
  const map: Record<string, string> = {};
  for (const p of parts) map[p.type] = p.value;
  return { yyyy: map.year, mm: map.month, dd: map.day };
}

// POST /api/store/orders {shopId, items:[{productId,qty}], fulfilment, deliveryAddress, deliveryPhone, notes}
// Global account orders from any shop: shopId comes from the cart. The order
// attaches to the shop's POS customer row (found-or-created by phone) so shop
// history, khata and stats keep working; onlineUserId links it to the account.
store.post("/orders", requireCustomerAuth as any, async (c) => {
  let idemKey: string | null = null;
  let orderFingerprint: string | null = null;
  let orderShopId: string | null = null;
  try {
    const cust: any = (c as any).get("customer");
    const body: any = await c.req.json();
    const shopId = String(body.shopId ?? "").trim();
    if (!shopId) return c.json({ error: "shopId required", code: "SHOP_REQUIRED" }, 400);
    orderShopId = shopId;
    const shop: any = await ensureOnlineShop(shopId);
    if (!shop.codEnabled) return c.json({ error: "COD is disabled for this shop", code: "COD_DISABLED" }, 403);

    const items = body.items;
    if (!Array.isArray(items) || items.length === 0 || items.length > 50) return c.json({ error: "items[1..50] required" }, 400);
    const fulfilment = String(body.fulfilment ?? "pickup").toLowerCase();
    if (!["pickup", "delivery"].includes(fulfilment)) return c.json({ error: "fulfilment must be pickup|delivery" }, 400);
    if (fulfilment === "pickup" && !shop.pickupEnabled) return c.json({ error: "Pickup is disabled for this shop" }, 403);
    if (fulfilment === "delivery" && !shop.deliveryEnabled) return c.json({ error: "Delivery is disabled for this shop" }, 403);
    const deliveryAddress = body.deliveryAddress ? String(body.deliveryAddress).trim().slice(0, 500) : null;
    const deliveryPhone = normalizePhone(body.deliveryPhone ?? cust.phone);
    if (fulfilment === "delivery" && !deliveryAddress) return c.json({ error: "deliveryAddress required for delivery" }, 400);

    idemKey = getIdempotencyKey(c, body);
    if (idemKey && !isValidIdempotencyKey(idemKey)) return c.json({ error: "Invalid Idempotency-Key", code: "INVALID_IDEMPOTENCY_KEY" }, 400);

    // Resolve products server-side — onlinePrice first, only isOnline + in stock.
    const ids = [...new Set(items.map((it: any) => String(it.productId ?? "")))].filter(Boolean);
    if (ids.length !== items.length) return c.json({ error: "Duplicate productId in items" }, 400);
    const dbProds: any[] = await prisma.product.findMany({ where: { id: { in: ids } } });
    const byId = new Map(dbProds.map((p: any) => [p.id, p]));
    let gross = 0;
    const lines: any[] = [];
    for (const it of items) {
      const pid = String(it.productId);
      const qty = Number(it.qty ?? it.quantity ?? it.weight ?? 0);
      if (!Number.isFinite(qty) || qty <= 0 || qty > 999) return c.json({ error: `Invalid qty for item` }, 400);
      const p: any = byId.get(pid);
      if (!p || p.deletedAt) return c.json({ error: "Product not available", code: "PRODUCT_UNAVAILABLE" }, 409);
      if (p.shopId !== shopId) return c.json({ error: "Product belongs to another shop" }, 403);
      if (!p.isOnline) return c.json({ error: `Not available online: ${p.name}`, code: "NOT_ONLINE" }, 409);
      const unitPrice = effectivePrice(p);
      if (!Number.isFinite(unitPrice) || unitPrice < 0 || unitPrice > MAX_MONEY) return c.json({ error: `Bad price: ${p.name}` }, 409);
      const lineTotal = round2(unitPrice * qty);
      gross = round2(gross + lineTotal);
      lines.push({ p, qty, unitPrice, lineTotal });
    }
    // Delivery fee / minimums from shop online config
    let deliveryFee = 0;
    if (fulfilment === "delivery") {
      const fee = dec(shop.deliveryFee);
      const freeAbove = shop.freeDeliveryAbove != null ? dec(shop.freeDeliveryAbove) : null;
      deliveryFee = freeAbove != null && gross >= freeAbove ? 0 : fee;
    }
    const total = round2(gross + deliveryFee);
    const minOrder = dec(shop.minOrderAmount);
    if (minOrder > 0 && total < minOrder) return c.json({ error: `Minimum order is ₹${minOrder.toFixed(2)}`, code: "MIN_ORDER" }, 422);

    orderFingerprint = idemKey ? fingerprint({ total, fulfilment, shopId, items: lines.map((l) => ({ productId: l.p.id, qty: l.qty, lineTotal: l.lineTotal })), customer: cust.id }) : null;
    if (idemKey) {
      const dup: any = await prisma.order.findFirst({ where: { shopId, idempotencyKey: idemKey }, include: { items: true } });
      if (dup) {
        if (dup.idempotencyFingerprint && dup.idempotencyFingerprint !== orderFingerprint) {
          return c.json({ error: "Idempotency-Key already used for a different bill", code: "IDEMPOTENCY_KEY_REUSED" }, 422);
        }
        return c.json({ order: dup, idempotentReplay: true });
      }
    }

    const notes = body.notes ? String(body.notes).trim().slice(0, 500) : null;
    // Link (or create) the shop's POS customer row by phone — the order's
    // per-shop home. Profile gaps fill in; POS data is never overwritten.
    let posCust: any = await prisma.customer.findFirst({ where: { shopId, phone: cust.phone, deletedAt: null } });
    if (!posCust) {
      posCust = await prisma.customer.create({
        data: { shopId, name: cust.name, phone: cust.phone, email: cust.email, address: cust.address ?? null, balance: 0 },
      });
    } else if ((!posCust.email && cust.email) || (!posCust.address && cust.address)) {
      posCust = await prisma.customer.update({
        where: { id: posCust.id },
        data: {
          ...(posCust.email ? {} : { email: cust.email }),
          ...(posCust.address ? {} : { address: cust.address }),
        },
      });
    }
    const order: any = await prisma.$transaction(async (tx: any) => {
      const seq = await tx.shopOrderSeq.upsert({ where: { shopId }, update: { lastNo: { increment: 1 } }, create: { shopId, lastNo: 1 } });
      const { yyyy, mm, dd } = istDateParts();
      const shopShort = shopId.slice(-4).toUpperCase().padStart(4, "0");
      const orderNumber = `ORD-${yyyy}${mm}${dd}-${shopShort}-${String(seq.lastNo).padStart(4, "0")}`;
      const created = await tx.order.create({
        data: {
          orderNumber, shopId, userId: null, total, discount: 0,
          paymentMethod: "cash", customerId: posCust.id, onlineUserId: cust.id, status: "pending",
          channel: "online", fulfilment, deliveryAddress, deliveryPhone, notes,
          ...(idemKey ? { idempotencyKey: idemKey, idempotencyFingerprint: orderFingerprint } : {}),
          items: {
            create: lines.map((l) => ({
              productId: l.p.id, name: l.p.name, price: l.unitPrice, unit: l.p.unit ?? "pcs",
              quantity: l.p.is_loose ? null : l.qty, weight: l.p.is_loose ? l.qty : null,
              lineTotal: l.lineTotal, isCustom: false, costPrice: dec(l.p.costPrice), category: l.p.category ?? null,
            })),
          },
        },
        include: { items: true },
      });
      for (const l of lines) {
        const res = await tx.product.updateMany({ where: { id: l.p.id, stockQuantity: { gte: l.qty } }, data: { stockQuantity: { decrement: l.qty } } });
        if (res.count === 0) throw new AppError(409, `Out of stock: ${l.p.name}`, "OUT_OF_STOCK");
      }
      const now = new Date();
      await tx.customer.update({ where: { id: posCust.id }, data: { totalSpent: { increment: total }, totalOrders: { increment: 1 }, lastOrderAt: now } });
      return created;
    });
    try {
      const { invalidateAnalyticsCache } = await import("./analytics.js");
      invalidateAnalyticsCache();
    } catch { /* best-effort */ }
    return c.json({ order }, 201);
  } catch (e) {
    if (e instanceof AppError) return c.json({ error: e.message, code: e.code }, e.status as 400 | 403 | 404 | 409 | 422);
    if (idemKey) {
      const msg = e instanceof Error ? e.message : "";
      if (msg.includes("P2002")) {
        try {
          const winner: any = await prisma.order.findFirst({ where: { shopId: orderShopId ?? undefined, idempotencyKey: idemKey }, include: { items: true } });
          if (winner) return c.json({ order: winner, idempotentReplay: true });
        } catch { /* fall through */ }
      }
    }
    console.error("[POST /store/orders]", e);
    const appErr = toAppError(e);
    return c.json({ error: appErr.message, code: appErr.code }, 500);
  }
});

// GET /api/store/orders/mine — all shops, one account.
store.get("/orders/mine", requireCustomerAuth as any, async (c) => {
  try {
    const cust: any = (c as any).get("customer");
    const limit = Math.min(parseInt(c.req.query("limit") ?? "20", 10) || 20, 50);
    const orders = await prisma.order.findMany({
      where: { onlineUserId: cust.id, deletedAt: null },
      include: { items: true, shop: { select: { id: true, name: true } } },
      orderBy: { createdAt: "desc" }, take: limit,
    });
    return c.json({ orders });
  } catch (e) {
    const appErr = toAppError(e);
    return c.json({ error: appErr.message, code: appErr.code }, 500);
  }
});

// POST /api/store/orders/:id/cancel (pending only, own orders)
store.post("/orders/:id/cancel", requireCustomerAuth as any, async (c) => {
  try {
    const cust: any = (c as any).get("customer");
    const id = c.req.param("id");
    const existing: any = await prisma.order.findUnique({ where: { id }, include: { items: true } });
    if (!existing || existing.deletedAt) return c.json({ error: "Order not found" }, 404);
    if (existing.onlineUserId !== cust.id) return c.json({ error: "Forbidden" }, 403);
    if (existing.status !== "pending") return c.json({ error: "Only pending orders can be cancelled", code: "NOT_CANCELLABLE" }, 409);
    const total = dec(existing.total);
    await prisma.$transaction(async (tx: any) => {
      await tx.order.update({ where: { id }, data: { status: "cancelled" } });
      for (const it of existing.items) {
        if (!it.isCustom && it.productId) {
          const qty = Number(it.quantity ?? it.weight ?? 0);
          if (qty > 0) await tx.product.updateMany({ where: { id: String(it.productId) }, data: { stockQuantity: { increment: qty } } });
        }
      }
      if (existing.customerId) {
        await tx.customer.updateMany({ where: { id: existing.customerId }, data: { totalSpent: { decrement: total }, totalOrders: { decrement: 1 } } });
      }
    });
    const updated = await prisma.order.findUnique({ where: { id }, include: { items: true } });
    return c.json({ order: updated });
  } catch (e) {
    const appErr = toAppError(e);
    return c.json({ error: appErr.message, code: appErr.code }, 500);
  }
});

export function sanitizeCustomerPublic(_r: unknown) {
  return null;
}

export default store;
