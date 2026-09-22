import { Hono } from "hono";
import { prisma } from "../lib/prisma.js";
import { computeDueDate, generateOrderNumber, getNextOrderNumber } from "../lib/utils.js";

const orders = new Hono();

// GET /api/orders/next-number (must be before /:id)
orders.get("/next-number", async (c) => {
  try {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const count = await prisma.order.count({ where: { createdAt: { gte: today } } });
    const yyyy = today.getFullYear();
    const mm = String(today.getMonth() + 1).padStart(2, "0");
    const dd = String(today.getDate()).padStart(2, "0");
    const seq = String(count + 1).padStart(3, "0");
    return c.json({ orderNumber: `ORD-${yyyy}${mm}${dd}-${seq}`, count });
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
  const limit = Math.min(parseInt(c.req.query("limit") ?? "50", 10), 100);
  const page = Math.max(parseInt(c.req.query("page") ?? "1", 10), 1);
  const customerId = c.req.query("customerId");
  const paymentMethod = c.req.query("paymentMethod");
  const search = (c.req.query("search") ?? "").trim();
  const date = c.req.query("date");

  try {
    const where: Record<string, unknown> = {};
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

    const [items, total] = await Promise.all([
      prisma.order.findMany({
        where,
        include: { items: true, customer: { select: { id: true, name: true, phone: true } } },
        orderBy: { createdAt: "desc" },
        take: limit,
        skip: (page - 1) * limit,
      }),
      prisma.order.count({ where }),
    ]);

    return c.json({ orders: items, total, page, limit });
  } catch (e) {
    return c.json({ error: e instanceof Error ? e.message : "Failed to fetch orders", orders: [], total: 0 }, 500);
  }
});

// GET /api/orders/:id  (id or orderNumber)
orders.get("/:id", async (c) => {
  const id = c.req.param("id");
  try {
    const order = await prisma.order.findFirst({
      where: { OR: [{ id }, { orderNumber: id }] },
      include: { items: true, customer: true },
    });
    if (!order) return c.json({ error: "Order not found" }, 404);
    return c.json({ order });
  } catch (e) {
    return c.json({ error: e instanceof Error ? e.message : "Error" }, 500);
  }
});

// POST /api/orders
orders.post("/", async (c) => {
  try {
    const body = await c.req.json();
    const { items, total, discount = 0, paymentMethod, customerId, customerName, customerPhone, status = "completed", creditDays, customDays } = body;

    if (!Array.isArray(items) || items.length === 0) {
      return c.json({ error: "Items required" }, 400);
    }
    if (typeof total !== "number" || total < 0) {
      return c.json({ error: "Valid total required" }, 400);
    }
    if (!paymentMethod || !["cash", "upi", "khata", "split"].includes(paymentMethod)) {
      return c.json({ error: "Invalid paymentMethod" }, 400);
    }

    const orderNumber = await getNextOrderNumber(prisma as any).catch(() => generateOrderNumber());

    let resolvedCustomerId = customerId ?? null;

    if (!resolvedCustomerId && (customerName || customerPhone) && paymentMethod === "khata") {
      const phone = customerPhone ? String(customerPhone).trim().replace(/\D/g, "").slice(0, 10) : null;
      const name = customerName ? String(customerName).trim() : "Walk-in Customer";
      if (phone) {
        const existing = await prisma.customer.findUnique({ where: { phone } });
        if (existing) {
          resolvedCustomerId = existing.id;
          await prisma.customer.update({
            where: { id: existing.id },
            data: {
              balance: { increment: total },
              totalSpent: { increment: total },
              totalOrders: { increment: 1 },
              lastOrderAt: new Date(),
            },
          });
        } else {
          const cust = await prisma.customer.create({
            data: {
              name,
              phone,
              balance: total,
              totalSpent: total,
              totalOrders: 1,
              lastOrderAt: new Date(),
            },
          });
          resolvedCustomerId = cust.id;
        }
      } else if (name && name !== "Walk-in Customer") {
        const cust = await prisma.customer.create({
          data: { name, balance: total, totalSpent: total, totalOrders: 1, lastOrderAt: new Date() },
        });
        resolvedCustomerId = cust.id;
      }
    } else if (resolvedCustomerId) {
      try {
        await prisma.customer.update({
          where: { id: resolvedCustomerId },
          data: {
            totalSpent: { increment: total },
            totalOrders: { increment: 1 },
            lastOrderAt: new Date(),
            ...(paymentMethod === "khata" ? { balance: { increment: total } } : {}),
          },
        });
      } catch {
        // ignore
      }
    }

    const order = await prisma.order.create({
      data: {
        orderNumber,
        total: Number(total),
        discount: Number(discount),
        paymentMethod,
        customerId: resolvedCustomerId,
        status,
        items: {
          create: items.map((it: Record<string, unknown>) => ({
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
      try {
        let days = Number(creditDays ?? customDays);
        if (isNaN(days) || days <= 0) days = 30;
        days = Math.round(days);
        if (days < 1) days = 1;
        if (days > 365) days = 365;
        const dueDate = computeDueDate(days);
        await prisma.ledgerEntry.create({
          data: {
            customerId: resolvedCustomerId,
            orderId: order.id,
            amount: Number(total),
            creditDays: days,
            dueDate,
            status: "pending",
          },
        });
      } catch (e) {
        console.warn("[POST /orders] ledger create failed:", e instanceof Error ? e.message : e);
      }
    }

    for (const it of items as Array<Record<string, unknown>>) {
      if (!it.isCustom && it.productId) {
        try {
          const qty = Number(it.quantity ?? it.weight ?? 1);
          await prisma.product.update({
            where: { id: String(it.productId) },
            data: { stockQuantity: { decrement: qty } },
          });
        } catch {
          // ignore
        }
      }
    }

    return c.json({ order }, 201);
  } catch (e) {
    console.error("[POST /orders]", e);
    const msg = e instanceof Error ? e.message : "Failed to create order";
    if (msg.includes("DATABASE_URL") || msg.includes("connect") || msg.includes("Can't reach")) {
      return c.json({ error: "Database not configured. Set DATABASE_URL", code: "DB_NOT_CONFIGURED" }, 503);
    }
    return c.json({ error: msg }, 500);
  }
});

export default orders;
