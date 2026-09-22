import { Hono } from "hono";
import { prisma } from "../lib/prisma.js";
import { addDays, endOfDay, startOfDay } from "../lib/utils.js";

const ledger = new Hono();

// GET /api/ledger/due-today?q&includeOverdue  (must be before /:id)
ledger.get("/due-today", async (c) => {
  const q = (c.req.query("q") ?? "").trim();
  const includeOverdue = c.req.query("includeOverdue") === "1" || c.req.query("overdue") === "1";

  try {
    const todayStart = startOfDay(new Date());
    const todayEnd = endOfDay(new Date());

    const where: Record<string, unknown> = {
      status: "pending" as const,
    };

    if (includeOverdue) {
      (where as Record<string, unknown>).dueDate = { lte: todayEnd };
    } else {
      (where as Record<string, unknown>).dueDate = { gte: todayStart, lte: todayEnd };
    }

    if (q) {
      const customers = await prisma.customer.findMany({
        where: {
          OR: [
            { name: { contains: q, mode: "insensitive" as const } },
            { phone: { contains: q } },
          ],
        },
        select: { id: true },
        take: 50,
      });
      const ids = customers.map((x: { id: string }) => x.id);
      if (ids.length === 0) return c.json({ entries: [], total: 0, count: 0, amount: 0 });
      (where as Record<string, unknown>).customerId = { in: ids };
    }

    const [entries, agg] = await Promise.all([
      prisma.ledgerEntry.findMany({
        where,
        include: { customer: { select: { id: true, name: true, phone: true, balance: true } }, order: { select: { id: true, orderNumber: true } } },
        orderBy: [{ dueDate: "asc" }, { createdAt: "desc" }],
        take: 100,
      }),
      prisma.ledgerEntry.aggregate({ where, _count: { _all: true }, _sum: { amount: true } }),
    ]);

    return c.json({ entries, total: agg._count._all, count: agg._count._all, amount: agg._sum.amount ?? 0 });
  } catch (e) {
    return c.json({ error: e instanceof Error ? e.message : "Failed", entries: [], total: 0 }, 500);
  }
});

// GET /api/ledger?filter&q&customerId&page&limit&due
ledger.get("/", async (c) => {
  const limit = Math.min(parseInt(c.req.query("limit") ?? "50", 10), 100);
  const page = Math.max(parseInt(c.req.query("page") ?? "1", 10), 1);
  const filter = (c.req.query("filter") ?? "all").toLowerCase();
  const q = (c.req.query("q") ?? "").trim();
  const customerId = c.req.query("customerId") ?? "";
  const dueToday = c.req.query("due") === "today" || filter === "duetoday" || filter === "due_today" || filter === "due-today";

  try {
    const where: Record<string, unknown> = {};

    if (customerId) where.customerId = customerId;

    if (filter === "pending") where.status = "pending";
    else if (filter === "settled") where.status = "settled";
    else if (filter === "overdue") {
      const nowStart = startOfDay(new Date());
      where.status = "pending";
      (where as Record<string, unknown>).dueDate = { lt: nowStart };
    } else if (dueToday) {
      const todayStart = startOfDay(new Date());
      const todayEnd = endOfDay(new Date());
      where.status = "pending";
      (where as Record<string, unknown>).dueDate = { gte: todayStart, lte: todayEnd };
    }

    let idsFromSearch: string[] | null = null;
    if (q) {
      const customers = await prisma.customer.findMany({
        where: {
          OR: [
            { name: { contains: q, mode: "insensitive" as const } },
            { phone: { contains: q } },
          ],
        },
        select: { id: true },
        take: 50,
      });
      idsFromSearch = customers.map((x: { id: string }) => x.id);
      if (idsFromSearch!.length === 0) {
        return c.json({ entries: [], total: 0, page, limit, stats: { dueToday: { count: 0, amount: 0 }, overdue: { count: 0, amount: 0 }, pending: { count: 0, amount: 0 } } });
      }
      (where as Record<string, unknown>).customerId = { in: idsFromSearch };
    }

    const [entries, total] = await Promise.all([
      prisma.ledgerEntry.findMany({
        where,
        include: { customer: { select: { id: true, name: true, phone: true, balance: true } }, order: { select: { id: true, orderNumber: true, total: true } } },
        orderBy: [{ dueDate: "asc" }, { createdAt: "desc" }],
        take: limit,
        skip: (page - 1) * limit,
      }),
      prisma.ledgerEntry.count({ where }),
    ]);

    const todayStart = startOfDay(new Date());
    const todayEnd = endOfDay(new Date());
    const [dueTodayAgg, overdueAgg, pendingAgg] = await Promise.all([
      prisma.ledgerEntry.aggregate({ where: { status: "pending", dueDate: { gte: todayStart, lte: todayEnd } }, _count: { _all: true }, _sum: { amount: true } }),
      prisma.ledgerEntry.aggregate({ where: { status: "pending", dueDate: { lt: todayStart } }, _count: { _all: true }, _sum: { amount: true } }),
      prisma.ledgerEntry.aggregate({ where: { status: "pending" }, _count: { _all: true }, _sum: { amount: true } }),
    ]);

    return c.json({
      entries,
      total,
      page,
      limit,
      stats: {
        dueToday: { count: dueTodayAgg._count._all, amount: dueTodayAgg._sum.amount ?? 0 },
        overdue: { count: overdueAgg._count._all, amount: overdueAgg._sum.amount ?? 0 },
        pending: { count: pendingAgg._count._all, amount: pendingAgg._sum.amount ?? 0 },
      },
    });
  } catch (e) {
    return c.json({ error: e instanceof Error ? e.message : "Failed to fetch ledger", entries: [], total: 0 }, 500);
  }
});

// POST /api/ledger
ledger.post("/", async (c) => {
  try {
    const body = await c.req.json();
    const { customerId, customerName, customerPhone, amount, creditDays, customDays, note, orderId } = body;

    const parsedAmount = Number(amount);
    if (!parsedAmount || isNaN(parsedAmount) || parsedAmount <= 0) {
      return c.json({ error: "Valid amount required (>0)" }, 400);
    }

    let days = Number(creditDays ?? customDays);
    if (isNaN(days) || days <= 0) {
      const cd = Number(customDays);
      if (!isNaN(cd) && cd > 0) days = cd;
      else if (body.creditTerm === 7 || body.creditTerm === 15 || body.creditTerm === 30) days = Number(body.creditTerm);
      else days = 30;
    }
    days = Math.round(days);
    if (days < 1 || days > 365) return c.json({ error: "creditDays must be between 1 and 365" }, 400);

    let resolvedCustomerId = customerId ? String(customerId) : null;

    if (!resolvedCustomerId) {
      const name = customerName ? String(customerName).trim() : "";
      const phoneRaw = customerPhone ? String(customerPhone).trim().replace(/\D/g, "").slice(0, 10) : "";
      const phone = phoneRaw && /^\d{10}$/.test(phoneRaw) ? phoneRaw : null;

      if (!name && !phone) {
        return c.json({ error: "Customer name or phone required" }, 400);
      }

      if (phone) {
        const existing = await prisma.customer.findUnique({ where: { phone } });
        if (existing) {
          resolvedCustomerId = existing.id;
        } else {
          const created = await prisma.customer.create({
            data: {
              name: name || `Customer ${phone.slice(-4)}`,
              phone,
              balance: 0,
            },
          });
          resolvedCustomerId = created.id;
        }
      } else if (name) {
        const created = await prisma.customer.create({
          data: {
            name,
            balance: 0,
          },
        });
        resolvedCustomerId = created.id;
      }
    } else {
      const exists = await prisma.customer.findUnique({ where: { id: resolvedCustomerId } });
      if (!exists) return c.json({ error: "Customer not found" }, 404);
    }

    const now = new Date();
    const dueDate = addDays(startOfDay(now), days);
    const dueDateNormalized = startOfDay(dueDate);

    const orderRef = orderId ? String(orderId) : null;
    if (orderRef) {
      const o = await prisma.order.findUnique({ where: { id: orderRef } });
      if (!o) return c.json({ error: "Order not found for orderId" }, 404);
    }

    const entry = await prisma.ledgerEntry.create({
      data: {
        customerId: resolvedCustomerId!,
        orderId: orderRef,
        amount: parsedAmount,
        creditDays: days,
        dueDate: dueDateNormalized,
        status: "pending",
        note: note ? String(note).trim().slice(0, 300) : null,
      },
      include: { customer: { select: { id: true, name: true, phone: true, balance: true } }, order: { select: { id: true, orderNumber: true } } },
    });

    await prisma.customer.update({
      where: { id: resolvedCustomerId! },
      data: { balance: { increment: parsedAmount } },
    });

    const updatedCustomer = await prisma.customer.findUnique({ where: { id: resolvedCustomerId! }, select: { id: true, name: true, phone: true, balance: true } });

    return c.json({ entry: { ...entry, customer: updatedCustomer } }, 201);
  } catch (e) {
    const msg = e instanceof Error ? e.message : "Failed to create ledger entry";
    if (msg.includes("DATABASE_URL") || msg.includes("connect")) {
      return c.json({ error: "Database not configured" }, 503);
    }
    return c.json({ error: msg }, 500);
  }
});

// GET /api/ledger/:id
ledger.get("/:id", async (c) => {
  const id = c.req.param("id");
  try {
    const entry = await prisma.ledgerEntry.findUnique({
      where: { id },
      include: { customer: { select: { id: true, name: true, phone: true, balance: true } }, order: { select: { id: true, orderNumber: true, total: true } } },
    });
    if (!entry) return c.json({ error: "Not found" }, 404);
    return c.json({ entry });
  } catch (e) {
    return c.json({ error: e instanceof Error ? e.message : "Failed" }, 500);
  }
});

// PATCH /api/ledger/:id {action: settle|reopen}
ledger.patch("/:id", async (c) => {
  const id = c.req.param("id");
  try {
    const body = await c.req.json().catch(() => ({}));
    const action = (body.action ?? "settle").toLowerCase();

    const entry = await prisma.ledgerEntry.findUnique({ where: { id }, include: { customer: true } });
    if (!entry) return c.json({ error: "Ledger entry not found" }, 404);

    if (action === "settle" || action === "paid" || action === "collect") {
      if (entry.status === "settled") {
        return c.json({ entry, message: "Already settled" });
      }
      const updated = await prisma.ledgerEntry.update({
        where: { id },
        data: { status: "settled", settledAt: new Date() },
        include: { customer: { select: { id: true, name: true, phone: true, balance: true } }, order: { select: { id: true, orderNumber: true } } },
      });

      await prisma.customer.update({
        where: { id: entry.customerId },
        data: { balance: { decrement: entry.amount } },
      });

      const cust = await prisma.customer.findUnique({ where: { id: entry.customerId } });
      if (cust && cust.balance < 0) {
        await prisma.customer.update({ where: { id: cust.id }, data: { balance: 0 } });
      }

      const finalCustomer = await prisma.customer.findUnique({ where: { id: entry.customerId }, select: { id: true, name: true, phone: true, balance: true } });
      return c.json({ entry: { ...updated, customer: finalCustomer } });
    }

    if (action === "reopen" || action === "undo") {
      if (entry.status !== "settled") {
        return c.json({ error: "Only settled entries can be reopened" }, 400);
      }
      const updated = await prisma.ledgerEntry.update({
        where: { id },
        data: { status: "pending", settledAt: null },
        include: { customer: { select: { id: true, name: true, phone: true, balance: true } } },
      });
      await prisma.customer.update({ where: { id: entry.customerId }, data: { balance: { increment: entry.amount } } });
      const finalCustomer = await prisma.customer.findUnique({ where: { id: entry.customerId }, select: { id: true, name: true, phone: true, balance: true } });
      return c.json({ entry: { ...updated, customer: finalCustomer } });
    }

    return c.json({ error: "Unknown action. Use settle or reopen" }, 400);
  } catch (e) {
    return c.json({ error: e instanceof Error ? e.message : "Failed to update" }, 500);
  }
});

// DELETE /api/ledger/:id
ledger.delete("/:id", async (c) => {
  const id = c.req.param("id");
  try {
    const entry = await prisma.ledgerEntry.findUnique({ where: { id } });
    if (!entry) return c.json({ error: "Not found" }, 404);
    if (entry.status === "pending") {
      await prisma.customer.update({ where: { id: entry.customerId }, data: { balance: { decrement: entry.amount } } });
      const cust = await prisma.customer.findUnique({ where: { id: entry.customerId } });
      if (cust && cust.balance < 0) await prisma.customer.update({ where: { id: cust.id }, data: { balance: 0 } });
    }
    await prisma.ledgerEntry.delete({ where: { id } });
    return c.json({ success: true });
  } catch (e) {
    return c.json({ error: e instanceof Error ? e.message : "Failed" }, 500);
  }
});

export default ledger;
