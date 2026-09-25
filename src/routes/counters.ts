import { Hono } from "hono";
import { prisma } from "../lib/prisma.js";
import { requireAuth, requireRole } from "../middleware/auth.js";

const counters = new Hono();

counters.use("*", requireAuth as any);

// GET /api/counters?shopId=  — list counters for shop (shopId from token unless SUPER_ADMIN)
counters.get("/", async (c) => {
  const user = (c as any).get("user" as any) as any;
  const queryShopId = c.req.query("shopId");
  let shopId: string | null = null;

  if (user.role === "SUPER_ADMIN") {
    shopId = queryShopId || null;
    if (!shopId) {
      // return all counters grouped? For super admin without shopId, return all
      const all = await prisma.counter.findMany({ where: { deletedAt: null }, include: { shop: { select: { id: true, name: true } } }, orderBy: { createdAt: "desc" } });
      return c.json({ counters: all });
    }
  } else {
    shopId = user.shopId;
  }

  if (!shopId) return c.json({ error: "Shop not found" }, 400);
  const items = await prisma.counter.findMany({ where: { shopId, deletedAt: null }, orderBy: { createdAt: "asc" } });
  return c.json({ counters: items });
});

// POST /api/counters {name, shopId?}
counters.post("/", requireRole("SUPER_ADMIN", "SHOP_OWNER") as any, async (c) => {
  const user = (c as any).get("user" as any) as any;
  try {
    const body = await c.req.json();
    let shopId = body.shopId ? String(body.shopId) : null;
    const name = String(body.name ?? "").trim();

    if (!name) return c.json({ error: "Counter name required" }, 400);
    if (name.length > 50) return c.json({ error: "Name too long" }, 400);

    if (user.role === "SHOP_OWNER" || user.role === "STAFF") {
      shopId = user.shopId;
    } else if (user.role === "SUPER_ADMIN" && !shopId) {
      return c.json({ error: "shopId required for SUPER_ADMIN" }, 400);
    }

    if (!shopId) return c.json({ error: "shopId required" }, 400);

    const shop = await prisma.shop.findUnique({ where: { id: shopId } });
    if (!shop || (shop as any).deletedAt || !(shop as any).isActive) return c.json({ error: "Shop not found or inactive" }, 404);

    const existing = await prisma.counter.findFirst({ where: { shopId, name, deletedAt: null } });
    if (existing) return c.json({ error: "Counter name already exists in this shop" }, 409);

    const counter = await prisma.counter.create({ data: { shopId, name } });
    return c.json({ counter }, 201);
  } catch (e) {
    return c.json({ error: e instanceof Error ? e.message : "Failed" }, 500);
  }
});

// PATCH /api/counters/:id
counters.patch("/:id", requireRole("SUPER_ADMIN", "SHOP_OWNER") as any, async (c) => {
  const user = (c as any).get("user" as any) as any;
  const id = c.req.param("id");
  try {
    const counter = await prisma.counter.findUnique({ where: { id } });
    if (!counter || (counter as any).deletedAt) return c.json({ error: "Counter not found" }, 404);
    if (user.role !== "SUPER_ADMIN" && (counter as any).shopId !== user.shopId) return c.json({ error: "Forbidden" }, 403);

    const body = await c.req.json();
    const data: Record<string, unknown> = {};
    if (body.name !== undefined) {
      const n = String(body.name).trim();
      if (!n) return c.json({ error: "Name required" }, 400);
      // uniqueness check
      const dup = await prisma.counter.findFirst({ where: { shopId: (counter as any).shopId, name: n, deletedAt: null, id: { not: id } } as any });
      if (dup) return c.json({ error: "Counter name already exists" }, 409);
      data.name = n;
    }
    if (body.isActive !== undefined) data.isActive = Boolean(body.isActive);
    if (Object.keys(data).length === 0) return c.json({ error: "No valid fields" }, 400);

    const updated = await prisma.counter.update({ where: { id }, data });
    return c.json({ counter: updated });
  } catch (e) {
    return c.json({ error: e instanceof Error ? e.message : "Failed" }, 500);
  }
});

// DELETE /api/counters/:id — soft delete
counters.delete("/:id", requireRole("SUPER_ADMIN", "SHOP_OWNER") as any, async (c) => {
  const user = (c as any).get("user" as any) as any;
  const id = c.req.param("id");
  try {
    const counter = await prisma.counter.findUnique({ where: { id } });
    if (!counter || (counter as any).deletedAt) return c.json({ error: "Not found or already deleted" }, 404);
    if (user.role !== "SUPER_ADMIN" && (counter as any).shopId !== user.shopId) return c.json({ error: "Forbidden" }, 403);
    const updated = await prisma.counter.update({ where: { id }, data: { deletedAt: new Date(), isActive: false } });
    return c.json({ counter: updated, softDeleted: true });
  } catch (e) {
    return c.json({ error: e instanceof Error ? e.message : "Failed" }, 500);
  }
});

// POST /api/counters/:id/restore
counters.post("/:id/restore", requireRole("SUPER_ADMIN", "SHOP_OWNER") as any, async (c) => {
  const user = (c as any).get("user" as any) as any;
  const id = c.req.param("id");
  try {
    const counter = await prisma.counter.findUnique({ where: { id } });
    if (!counter) return c.json({ error: "Not found" }, 404);
    if (!(counter as any).deletedAt) return c.json({ counter, message: "Already active" });
    if (user.role !== "SUPER_ADMIN" && (counter as any).shopId !== user.shopId) return c.json({ error: "Forbidden" }, 403);
    const updated = await prisma.counter.update({ where: { id }, data: { deletedAt: null, isActive: true } });
    return c.json({ counter: updated });
  } catch (e) {
    return c.json({ error: e instanceof Error ? e.message : "Failed" }, 500);
  }
});

export default counters;
