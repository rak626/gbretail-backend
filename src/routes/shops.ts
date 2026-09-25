import { Hono } from "hono";
import { prisma } from "../lib/prisma.js";
import { requireAuth, requireRole } from "../middleware/auth.js";

const shops = new Hono();

// All shop routes require auth; creation only SUPER_ADMIN, listing depends on role
shops.use("*", requireAuth as any);

// GET /api/shops — SUPER_ADMIN sees all, others see own shop only
shops.get("/", async (c) => {
  const user = (c as any).get("user" as any) as any;
  try {
    if (user.role === "SUPER_ADMIN") {
      const items = await prisma.shop.findMany({ where: { deletedAt: null }, orderBy: { createdAt: "desc" } });
      // Per-shop console meta (super only): owner, staff/product counts, last bill.
      // Additive fields — list shape stays { shops: [...] }.
      const enriched = await Promise.all(
        (items as any[]).map(async (s) => {
          const [owner, staffCount, productCount, lastOrder] = await Promise.all([
            prisma.user.findFirst({ where: { shopId: s.id, role: "SHOP_OWNER", deletedAt: null }, select: { id: true, name: true, email: true, isActive: true } }),
            prisma.user.count({ where: { shopId: s.id, role: "STAFF", deletedAt: null } }),
            prisma.product.count({ where: { shopId: s.id, deletedAt: null } as any }),
            prisma.order.findFirst({ where: { shopId: s.id, deletedAt: null } as any, orderBy: { createdAt: "desc" }, select: { createdAt: true } as any }),
          ]);
          return { ...s, owner: owner ?? null, staffCount, productCount, lastOrderAt: (lastOrder as any)?.createdAt ?? null };
        })
      );
      return c.json({ shops: enriched });
    }
    // Shop owner/staff: return own shop
    if (!user.shopId) return c.json({ shops: [] });
    const shop = await prisma.shop.findUnique({ where: { id: user.shopId } });
    if (!shop || (shop as any).deletedAt) return c.json({ shops: [] });
    return c.json({ shops: [shop] });
  } catch (e) {
    return c.json({ error: e instanceof Error ? e.message : "Failed" }, 500);
  }
});

// GET /api/shops/:id
shops.get("/:id", async (c) => {
  const user = (c as any).get("user" as any) as any;
  const id = c.req.param("id");
  try {
    const shop = await prisma.shop.findUnique({ where: { id }, include: { counters: { where: { deletedAt: null } }, users: { where: { deletedAt: null }, select: { id: true, email: true, name: true, role: true, isActive: true } } } });
    if (!shop || (shop as any).deletedAt) return c.json({ error: "Shop not found" }, 404);
    // Non-super can only see own shop
    if (user.role !== "SUPER_ADMIN" && user.shopId !== id) return c.json({ error: "Forbidden" }, 403);
    return c.json({ shop });
  } catch (e) {
    return c.json({ error: e instanceof Error ? e.message : "Failed" }, 500);
  }
});

// POST /api/shops — only SUPER_ADMIN
shops.post("/", requireRole("SUPER_ADMIN") as any, async (c) => {
  try {
    const body = await c.req.json();
    const name = String(body.name ?? "").trim();
    const address = body.address ? String(body.address).trim().slice(0, 500) : null;
    if (!name) return c.json({ error: "Shop name required" }, 400);
    if (name.length > 100) return c.json({ error: "Name too long" }, 400);
    const shop = await prisma.shop.create({ data: { name, address } });
    return c.json({ shop }, 201);
  } catch (e) {
    return c.json({ error: e instanceof Error ? e.message : "Failed" }, 500);
  }
});

// PATCH /api/shops/:id — SUPER_ADMIN or SHOP_OWNER of that shop
shops.patch("/:id", async (c) => {
  const user = (c as any).get("user" as any) as any;
  const id = c.req.param("id");
  if (user.role !== "SUPER_ADMIN" && user.shopId !== id) return c.json({ error: "Forbidden" }, 403);
  if (user.role === "STAFF") return c.json({ error: "Forbidden — staff cannot edit shop" }, 403);
  try {
    const body = await c.req.json();
    const data: Record<string, unknown> = {};
    if (body.name !== undefined) {
      const n = String(body.name).trim();
      if (!n) return c.json({ error: "Name required" }, 400);
      data.name = n;
    }
    if (body.address !== undefined) data.address = body.address ? String(body.address).trim().slice(0, 500) : null;
    if (body.isActive !== undefined) data.isActive = Boolean(body.isActive);
    if (Object.keys(data).length === 0) return c.json({ error: "No valid fields" }, 400);
    const shop = await prisma.shop.update({ where: { id }, data });
    return c.json({ shop });
  } catch (e) {
    return c.json({ error: e instanceof Error ? e.message : "Failed" }, 500);
  }
});

// DELETE /api/shops/:id — SUPER_ADMIN soft delete
shops.delete("/:id", requireRole("SUPER_ADMIN") as any, async (c) => {
  const id = c.req.param("id");
  try {
    const existing = await prisma.shop.findUnique({ where: { id } });
    if (!existing || (existing as any).deletedAt) return c.json({ error: "Not found or already deleted" }, 404);
    const shop = await prisma.shop.update({ where: { id }, data: { deletedAt: new Date(), isActive: false } });
    return c.json({ shop, softDeleted: true });
  } catch (e) {
    return c.json({ error: e instanceof Error ? e.message : "Failed" }, 500);
  }
});

// POST /api/shops/:id/restore — SUPER_ADMIN
shops.post("/:id/restore", requireRole("SUPER_ADMIN") as any, async (c) => {
  const id = c.req.param("id");
  try {
    const existing = await prisma.shop.findUnique({ where: { id } });
    if (!existing) return c.json({ error: "Not found" }, 404);
    if (!(existing as any).deletedAt) return c.json({ shop: existing, message: "Already active" });
    const shop = await prisma.shop.update({ where: { id }, data: { deletedAt: null, isActive: true } });
    return c.json({ shop });
  } catch (e) {
    return c.json({ error: e instanceof Error ? e.message : "Failed" }, 500);
  }
});

export default shops;
