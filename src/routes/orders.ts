import { Hono } from "hono";
import { prisma } from "../lib/prisma.js";
import { computeDueDate, generateOrderNumber, getNextOrderNumber } from "../lib/utils.js";
import { normalizePhone } from "../lib/normalize.js";
import { toAppError, AppError } from "../lib/errors.js";
import { requireAuth } from "../middleware/auth.js";

const orders = new Hono();

orders.use("*", requireAuth as any);

// Helper to get shop scope
function getShopScope(c: any) {
  const user = (c as any).get("user") as any;
  const shopId = ((c as any).get("shopId") as string | null) || user?.shopId || c.req.query("shopId") || null;
  return { user, shopId };
}

// Per-shop next number: count orders in shop today, with shop suffix to keep global unique + random tail for concurrency
async function getNextShopOrderNumber(tx: any, shopId: string | null) {
  if (!shopId) return generateOrderNumber();
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const count = await tx.order.count({ where: { shopId, createdAt: { gte: today }, deletedAt: null } as any });
  const yyyy = today.getFullYear();
  const mm = String(today.getMonth() + 1).padStart(2, "0");
  const dd = String(today.getDate()).padStart(2, "0");
  const seq = String(count + 1).padStart(3, "0");
  const shopShort = shopId.slice(-4).toUpperCase();
  // add 2-char random to avoid concurrent duplicate on same seq
  const rand = Math.random().toString(36).substring(2, 4).toUpperCase();
  return `ORD-${yyyy}${mm}${dd}-${shopShort}-${seq}${rand}`;
}

// GET /api/orders/next-number (must be before /:id)
orders.get("/next-number", async (c) => {
  const { user, shopId } = getShopScope(c);
  try {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const where: Record<string, unknown> = { createdAt: { gte: today }, deletedAt: null } as any;
    if (shopId) (where as any).shopId = shopId;
    else if (user.role !== "SUPER_ADMIN") return c.json({ error: "Shop not assigned" }, 403);
    const count = await prisma.order.count({ where } as any);
    const yyyy = today.getFullYear();
    const mm = String(today.getMonth() + 1).padStart(2, "0");
    const dd = String(today.getDate()).padStart(2, "0");
    const seq = String(count + 1).padStart(3, "0");
    const shopShort = shopId ? shopId.slice(-4).toUpperCase() : "";
    const orderNumber = shopId ? `ORD-${yyyy}${mm}${dd}-${shopShort}-${seq}` : `ORD-${yyyy}${mm}${dd}-${seq}`;
    return c.json({ orderNumber, count });
  } catch {
    const d = new Date();
    const yyyy = d.getFullYear();
    const mm = String(d.getMonth() + 1).padStart(2, "0");
    const dd = String(d.getDate()).padStart(2, "0");
    const rnd = Math.random().toString(36).substring(2, 6).toUpperCase();
    return c.json({ orderNumber: `ORD-${yyyy}${mm}${dd}-${rnd}`, count: 0, fallback: true });
  }
});

// GET /api/orders?page&limit&customerId&paymentMethod&search&date
orders.get("/", async (c) => {
  const rawLimit = parseInt(c.req.query("limit") ?? "50", 10);
  const limit = isNaN(rawLimit) ? 50 : Math.min(rawLimit, 100);
  const rawPage = parseInt(c.req.query("page") ?? "1", 10);
  const page = isNaN(rawPage) ? 1 : Math.max(rawPage, 1);
  const customerId = c.req.query("customerId");
  const paymentMethod = c.req.query("paymentMethod");
  const search = (c.req.query("search") ?? "").trim();
  const date = c.req.query("date");
  const { user, shopId } = getShopScope(c);

  try {
    const where: Record<string, unknown> = { deletedAt: null };
    if (shopId) (where as any).shopId = shopId;
    else if (user.role !== "SUPER_ADMIN") return c.json({ error: "Shop not assigned" }, 403);
    // super admin without shopId can see all, but filter by query shopId if provided
    if (customerId) where.customerId = customerId;
    if (paymentMethod) where.paymentMethod = paymentMethod;
    if (search) where.orderNumber = { contains: search, mode: "insensitive" as const };
    if (date) {
      const start = new Date(date);
      start.setHours(0, 0, 0, 0);
      const end = new Date(date);
      end.setHours(23, 59, 59, 999);
      where.createdAt = { gte: start, lte: end };
    }
    // optional counter filter
    const counterIdQ = c.req.query("counterId");
    if (counterIdQ) (where as any).counterId = counterIdQ;

    const [items, total] = await Promise.all([
      prisma.order.findMany({
        where: where as any,
        include: { items: true, customer: { select: { id: true, name: true, phone: true } }, shop: { select: { id: true, name: true } }, counter: { select: { id: true, name: true } }, user: { select: { id: true, name: true, email: true } } },
        orderBy: { createdAt: "desc" },
        take: limit,
        skip: (page - 1) * limit,
      }),
      prisma.order.count({ where: where as any }),
    ]);

    return c.json({ orders: items, total, page, limit });
  } catch (e) {
    return c.json({ error: e instanceof Error ? e.message : "Failed to fetch orders", orders: [], total: 0 }, 500);
  }
});

// GET /api/orders/:id  (id or orderNumber)
orders.get("/:id", async (c) => {
  const id = c.req.param("id");
  const { user, shopId } = getShopScope(c);
  try {
    const order = await prisma.order.findFirst({
      where: { OR: [{ id }, { orderNumber: id }] },
      include: { items: true, customer: true, shop: { select: { id: true, name: true } }, counter: { select: { id: true, name: true } }, user: { select: { id: true, name: true } } },
    });
    if (!order || (order as any).deletedAt) return c.json({ error: "Order not found" }, 404);
    if (shopId && (order as any).shopId && (order as any).shopId !== shopId && user.role !== "SUPER_ADMIN") {
      return c.json({ error: "Forbidden — order belongs to another shop" }, 403);
    }
    return c.json({ order });
  } catch (e) {
    return c.json({ error: e instanceof Error ? e.message : "Error" }, 500);
  }
});

// POST /api/orders
orders.post("/", async (c) => {
  try {
    const body = await c.req.json();
    const user = (c as any).get("user") as any;
    const urlShopId = c.req.query("shopId") as string | undefined;
    let shopId: string | null = ((c as any).get("shopId") as string | null) || user?.shopId || (urlShopId as string | null) || (body.shopId ? String(body.shopId) : null);
    if (user.role !== "SUPER_ADMIN" && !shopId) return c.json({ error: "Shop not assigned" }, 403);
    if (user.role === "SUPER_ADMIN" && !shopId) return c.json({ error: "shopId required for SUPER_ADMIN" }, 400);

    // Validate shop exists
    const shop = await prisma.shop.findUnique({ where: { id: shopId! } });
    if (!shop || (shop as any).deletedAt || !(shop as any).isActive) return c.json({ error: "Shop not found or inactive" }, 404);

    let { items, total, discount = 0, paymentMethod, customerId, customerName, customerPhone, status = "completed", creditDays, customDays, counterId } = body;

    if (!Array.isArray(items) || items.length === 0) {
      return c.json({ error: "Items required" }, 400);
    }
    if (!paymentMethod || !["cash", "upi", "khata", "split"].includes(paymentMethod)) {
      return c.json({ error: "Invalid paymentMethod" }, 400);
    }

    // Counter validation: must belong to shop if provided
    if (counterId) {
      const counter = await prisma.counter.findUnique({ where: { id: String(counterId) } });
      if (!counter || (counter as any).deletedAt || !(counter as any).isActive) return c.json({ error: "Counter not found or inactive" }, 404);
      if ((counter as any).shopId !== shopId) return c.json({ error: "Counter does not belong to shop" }, 403);
    } else {
      // auto pick first active counter of shop if not provided
      const firstCounter = await prisma.counter.findFirst({ where: { shopId: shopId!, deletedAt: null, isActive: true } });
      if (firstCounter) counterId = firstCounter.id;
    }

    // RECACLULATE totals server-side — never trust client total
    let gross = 0;
    for (const it of items as Record<string, unknown>[]) {
      const lt = Number((it as any).lineTotal);
      const price = Number((it as any).price);
      if (isNaN(lt) || lt < 0) return c.json({ error: `Invalid lineTotal for ${(it as any).name}` }, 400);
      if (isNaN(price) || price < 0) return c.json({ error: `Invalid price for ${(it as any).name}` }, 400);
      const q = Number((it as any).quantity ?? (it as any).weight ?? 1);
      if (isNaN(q) || q <= 0) return c.json({ error: `Invalid quantity/weight for ${(it as any).name}` }, 400);
      gross += lt;
    }
    gross = Math.round(gross * 100) / 100;
    discount = Number(discount);
    if (isNaN(discount) || discount < 0) return c.json({ error: "Discount must be >=0" }, 400);
    if (discount > gross) return c.json({ error: `Discount (${discount}) cannot exceed gross (${gross})` }, 400);
    const netTotal = Math.round((gross - discount) * 100) / 100;
    // Use netTotal as the order total (after discount)
    total = netTotal;

    // Use transaction to ensure atomicity: customer updates + order + ledger + stock
    // lowStockWarnings is informational only — sales are never blocked (warn-only)
    const lowStockWarnings: Array<{ productId: string; name: string; stockQuantity: number; lowStockThreshold: number; unit: string }> = [];
    const order = await prisma.$transaction(async (tx) => {
      // Order number per shop with retry on conflict
      let orderNumber: string;
      try {
        orderNumber = await getNextShopOrderNumber(tx as any, shopId);
      } catch {
        orderNumber = generateOrderNumber();
      }

      let resolvedCustomerId: string | null = customerId ? String(customerId) : null;
      const now = new Date();

      if (!resolvedCustomerId && (customerName || customerPhone) && paymentMethod === "khata") {
        const phone = normalizePhone(customerPhone);
        const name = customerName ? String(customerName).trim() : "Walk-in Customer";
        if (phone) {
          const existing = await tx.customer.findUnique({ where: { phone } });
          if (existing) {
            resolvedCustomerId = existing.id;
            const isFirst = !(existing as { firstOrderAt?: Date | null }).firstOrderAt;
            await tx.customer.update({
              where: { id: existing.id },
              data: {
                balance: { increment: total },
                totalSpent: { increment: total },
                totalOrders: { increment: 1 },
                lastOrderAt: now,
                ...(isFirst ? { firstOrderAt: now } : {}),
                ...((existing as { deletedAt?: Date | null }).deletedAt ? { deletedAt: null } : {}),
              },
            });
          } else {
            const cust = await tx.customer.create({
              data: {
                name,
                phone,
                balance: total,
                totalSpent: total,
                totalOrders: 1,
                firstOrderAt: now,
                lastOrderAt: now,
              },
            });
            resolvedCustomerId = cust.id;
          }
        } else if (name && name !== "Walk-in Customer") {
          const cust = await tx.customer.create({
            data: { name, balance: total, totalSpent: total, totalOrders: 1, firstOrderAt: now, lastOrderAt: now },
          });
          resolvedCustomerId = cust.id;
        }
      } else if (resolvedCustomerId) {
        const existing = await tx.customer.findUnique({ where: { id: resolvedCustomerId }, select: { firstOrderAt: true, deletedAt: true } });
        if (existing) {
          const isFirst = !existing?.firstOrderAt;
          await tx.customer.update({
            where: { id: resolvedCustomerId },
            data: {
              totalSpent: { increment: total },
              totalOrders: { increment: 1 },
              lastOrderAt: now,
              ...(isFirst ? { firstOrderAt: now } : {}),
              ...(existing?.deletedAt ? { deletedAt: null } : {}),
              ...(paymentMethod === "khata" ? { balance: { increment: total } } : {}),
            },
          });
        }
      } else if (resolvedCustomerId) {
        // fallback already handled
      } else if (customerId) {
        // customerId provided but not found? allow walk-in
        const exists = await tx.customer.findUnique({ where: { id: String(customerId) } });
        if (!exists) resolvedCustomerId = null;
      }

      // Create order with shop/counter/user tracking — orderNumber already shop-unique with random tail, no retry needed
      const createdOrder = await tx.order.create({
        data: {
          orderNumber,
          shopId: shopId!,
          counterId: counterId ? String(counterId) : null,
          userId: user.userId,
          total: Number(total),
          discount: Number(discount),
          paymentMethod,
          customerId: resolvedCustomerId,
          status,
          items: {
            create: (items as Record<string, unknown>[]).map((it) => ({
              productId: (it.productId as string) || null,
              name: String(it.name),
              price: Number(it.price),
              unit: String(it.unit ?? "pcs"),
              quantity: it.quantity != null ? Number(it.quantity) : null,
              weight: it.weight != null ? Number(it.weight) : null,
              lineTotal: Number(it.lineTotal),
              isCustom: Boolean(it.isCustom),
              costPrice: it.costPrice != null ? Number(it.costPrice) : null,
              category: it.category ? String(it.category) : null,
            })),
          },
        },
        include: { items: true, customer: true },
      });

      if (paymentMethod === "khata" && resolvedCustomerId) {
        const daysInput = Number(creditDays ?? customDays);
        const days = Number.isNaN(daysInput) || daysInput <= 0 ? 30 : Math.min(365, Math.max(1, Math.round(daysInput)));
        const dueDate = computeDueDate(days);
        await tx.ledgerEntry.create({
          data: {
            shopId: shopId!,
            counterId: counterId ? String(counterId) : null,
            userId: user.userId,
            customerId: resolvedCustomerId,
            orderId: createdOrder.id,
            amount: Number(total),
            creditDays: days,
            dueDate,
            status: "pending",
          },
        });
      }

      // Stock decrement — per shop, throw 409 if insufficient
      for (const it of items as Record<string, unknown>[]) {
        if (!it.isCustom && it.productId) {
          const qty = Number(it.quantity ?? it.weight ?? 1);
          if (qty <= 0) continue;
          // Verify product belongs to same shop
          const prod = await tx.product.findUnique({ where: { id: String(it.productId) } });
          if (!prod) throw new AppError(404, `Product ${(it as any).name} not found`);
          if ((prod as any).shopId && (prod as any).shopId !== shopId && user.role !== "SUPER_ADMIN") {
            throw new AppError(403, `Product ${(it as any).name} does not belong to your shop`);
          }
          if ((prod as any).deletedAt) throw new AppError(404, `Product ${(it as any).name} is deleted`);
          // Attempt conditional decrement
          const res = await tx.product.updateMany({
            where: { id: String(it.productId), stockQuantity: { gte: qty } },
            data: { stockQuantity: { decrement: qty } },
          });
          if ((res as any).count === 0) {
            // insufficient stock
            const fresh = await tx.product.findUnique({ where: { id: String(it.productId) }, select: { stockQuantity: true, name: true } });
            throw new AppError(409, `Insufficient stock for ${fresh?.name ?? (it as any).name}. Available: ${fresh?.stockQuantity ?? 0}, requested: ${qty}`);
          }
          // Warn-only: flag products now at/below their own threshold (never blocks the sale)
          const after = await tx.product.findUnique({ where: { id: String(it.productId) }, select: { stockQuantity: true, name: true, lowStockThreshold: true, unit: true } });
          if (after && (after.stockQuantity ?? 0) <= ((after as any).lowStockThreshold ?? 10)) {
            lowStockWarnings.push({
              productId: String(it.productId),
              name: (after as any).name,
              stockQuantity: (after as any).stockQuantity ?? 0,
              lowStockThreshold: (after as any).lowStockThreshold ?? 10,
              unit: (after as any).unit ?? "pcs",
            });
          }
        }
      }

      return createdOrder;
    });

    return c.json({ order, lowStockWarnings }, 201);
  } catch (e) {
    console.error("[POST /orders]", e);
    const appErr = toAppError(e);
    return c.json({ error: appErr.message, code: appErr.code }, appErr.status as 400 | 404 | 409 | 500 | 503);
  }
});

// DELETE /api/orders/:id — soft delete
orders.delete("/:id", async (c) => {
  const id = c.req.param("id");
  const { user, shopId } = getShopScope(c);
  try {
    const existing = await prisma.order.findUnique({ where: { id } });
    if (!existing || (existing as any).deletedAt) return c.json({ error: "Not found" }, 404);
    if (shopId && (existing as any).shopId && (existing as any).shopId !== shopId && user.role !== "SUPER_ADMIN") return c.json({ error: "Forbidden" }, 403);
    const updated = await prisma.order.update({ where: { id }, data: { deletedAt: new Date() } as any });
    return c.json({ order: updated, softDeleted: true });
  } catch (e) {
    return c.json({ error: e instanceof Error ? e.message : "Failed" }, 500);
  }
});

orders.post("/:id/restore", async (c) => {
  const id = c.req.param("id");
  const { user, shopId } = getShopScope(c);
  try {
    const existing = await prisma.order.findUnique({ where: { id } });
    if (!existing) return c.json({ error: "Not found" }, 404);
    if (!(existing as any).deletedAt) return c.json({ order: existing, message: "Already active" });
    if (shopId && (existing as any).shopId && (existing as any).shopId !== shopId && user.role !== "SUPER_ADMIN") return c.json({ error: "Forbidden" }, 403);
    const updated = await prisma.order.update({ where: { id }, data: { deletedAt: null } as any });
    return c.json({ order: updated });
  } catch (e) {
    return c.json({ error: e instanceof Error ? e.message : "Failed" }, 500);
  }
});

export default orders;
