import { Hono } from "hono";
import { prisma } from "../lib/prisma.js";

const customers = new Hono();

// GET /api/customers?q&limit
customers.get("/", async (c) => {
  const q = (c.req.query("q") ?? "").toLowerCase().trim();
  const limit = Math.min(parseInt(c.req.query("limit") ?? "50", 10), 100);

  try {
    if (q) {
      const items = await prisma.customer.findMany({
        where: {
          OR: [
            { name: { contains: q, mode: "insensitive" as const } },
            { phone: { contains: q } },
          ],
        },
        orderBy: { createdAt: "desc" },
        take: limit,
      });
      return c.json({ customers: items });
    }
    const items = await prisma.customer.findMany({
      orderBy: { createdAt: "desc" },
      take: limit,
    });
    return c.json({ customers: items });
  } catch (e) {
    return c.json({ error: e instanceof Error ? e.message : "Error", customers: [] }, 500);
  }
});

// GET /api/customers/:id
customers.get("/:id", async (c) => {
  const id = c.req.param("id");
  try {
    const customer = await prisma.customer.findUnique({
      where: { id },
      include: { orders: { orderBy: { createdAt: "desc" }, take: 10, include: { items: true } } },
    });
    if (!customer) return c.json({ error: "Not found" }, 404);
    return c.json({ customer });
  } catch (e) {
    return c.json({ error: e instanceof Error ? e.message : "Error" }, 500);
  }
});

// POST /api/customers
customers.post("/", async (c) => {
  try {
    const body = await c.req.json();
    const { name, phone, balance } = body;
    const trimmedName = String(name ?? "").trim();
    const trimmedPhone = phone ? String(phone).trim().replace(/\D/g, "").slice(0, 10) : null;

    if (!trimmedName) return c.json({ error: "Customer name is required" }, 400);
    if (trimmedPhone && !/^\d{10}$/.test(trimmedPhone)) {
      return c.json({ error: "Invalid phone" }, 400);
    }

    if (trimmedPhone) {
      const existing = await prisma.customer.findUnique({ where: { phone: trimmedPhone } });
      if (existing) return c.json({ error: "Customer with this phone already exists", customer: existing }, 409);
    }

    const customer = await prisma.customer.create({
      data: {
        name: trimmedName,
        phone: trimmedPhone || null,
        balance: balance != null ? Number(balance) : 0,
      },
    });

    return c.json({ customer }, 201);
  } catch (e) {
    const msg = e instanceof Error ? e.message : "Failed to create customer";
    if (msg.includes("DATABASE_URL") || msg.includes("connect")) {
      return c.json({ error: "Database not configured" }, 503);
    }
    return c.json({ error: msg }, 500);
  }
});

// PATCH /api/customers/:id
customers.patch("/:id", async (c) => {
  const id = c.req.param("id");
  try {
    const body = await c.req.json();
    const customer = await prisma.customer.update({ where: { id }, data: body });
    return c.json({ customer });
  } catch (e) {
    return c.json({ error: e instanceof Error ? e.message : "Error" }, 500);
  }
});

export default customers;
