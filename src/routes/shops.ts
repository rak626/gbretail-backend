import { Hono } from "hono";
import { prisma } from "../lib/prisma.js";
import { requireAuth, requireRole } from "../middleware/auth.js";

const shops = new Hono();

// Human shop ID: GB-SHOP-1001, 1002… Auto-only, immutable after creation.
// Uses the shop_code_seq sequence created in 20260927000000_shop_code.
async function allocateShopCode(): Promise<string> {
  const rows = await prisma.$queryRaw<Array<{ code: string }>>`SELECT 'GB-SHOP-' || nextval('shop_code_seq') AS code`;
  const code = rows[0]?.code;
  if (!code || !/^GB-SHOP-\d+$/.test(code)) throw new Error("Failed to allocate shop code");
  return code;
}

// Receipt identity fields (per-shop billing header). Shared by POST + PATCH.
// Returns the validated partial, or an error string. `partial` skips absent keys.
function receiptFields(body: Record<string, unknown>, partial = false): Record<string, unknown> | string {
  const out: Record<string, unknown> = {};
  const str = (v: unknown, max: number) => (v == null || String(v).trim() === "" ? null : String(v).trim().slice(0, max));
  if (!partial || body.receiptName !== undefined) out.receiptName = str(body.receiptName, 100);
  if (!partial || body.gstin !== undefined) {
    const g = str(body.gstin, 20);
    if (g && !/^[0-9A-Z]{15}$/i.test(g)) return "Invalid GSTIN (15 alphanumeric chars)";
    out.gstin = g ? g.toUpperCase() : null;
  }
  if (!partial || body.upiId !== undefined) {
    const u = str(body.upiId, 100);
    if (u && !/^[\w.\-]{2,}@[a-zA-Z]{2,}$/.test(u)) return "Invalid UPI id (format name@bank)";
    out.upiId = u;
  }
  if (!partial || body.phone !== undefined) {
    const p = body.phone != null && String(body.phone).trim() !== "" ? String(body.phone).replace(/\D/g, "").slice(-10) : null;
    if (body.phone != null && String(body.phone).trim() !== "" && (!p || !/^\d{10}$/.test(p))) return "Invalid shop phone (10 digits)";
    out.phone = p;
  }
  if (!partial || body.receiptFooter !== undefined) out.receiptFooter = str(body.receiptFooter, 200);
  return out;
}

// All shop routes require auth; creation only SUPER_ADMIN, listing depends on role
shops.use("*", requireAuth as any);

// GET /api/shops — SUPER_ADMIN sees all, others see own shop only
shops.get("/", async (c) => {
  const user = (c as any).get("user" as any) as any;
  try {
    if (user.role === "SUPER_ADMIN") {
      const items = await prisma.shop.findMany({ where: { deletedAt: null }, orderBy: { createdAt: "desc" }, take: 100 });
      // Batched meta: 4 grouped queries total (not 4×N). Capped at 100 shops.
      const shopIds = items.map((s) => s.id);
      const [owners, staffCounts, productCounts, lastOrders] = await Promise.all([
        prisma.user.findMany({ where: { shopId: { in: shopIds }, role: "SHOP_OWNER", deletedAt: null }, select: { id: true, name: true, email: true, isActive: true, shopId: true } }),
        prisma.user.groupBy({ by: ["shopId"], where: { shopId: { in: shopIds }, role: "STAFF", deletedAt: null }, _count: { _all: true } }),
        prisma.product.groupBy({ by: ["shopId"], where: { shopId: { in: shopIds }, deletedAt: null }, _count: { _all: true } }),
        prisma.order.groupBy({ by: ["shopId"], where: { shopId: { in: shopIds }, deletedAt: null }, _max: { createdAt: true } }),
      ]);
      const ownerByShop = new Map(owners.map((o: any) => [o.shopId, o]));
      const staffByShop = new Map(staffCounts.map((r: any) => [r.shopId, r._count._all]));
      const prodByShop = new Map(productCounts.map((r: any) => [r.shopId, r._count._all]));
      const lastByShop = new Map(lastOrders.map((r: any) => [r.shopId, r._max.createdAt]));
      const enriched = (items as any[]).map((s) => ({
        ...s,
        owner: ownerByShop.get(s.id) ?? null,
        staffCount: staffByShop.get(s.id) ?? 0,
        productCount: prodByShop.get(s.id) ?? 0,
        lastOrderAt: lastByShop.get(s.id) ?? null,
      }));
      return c.json({ shops: enriched });
    }
    // Shop owner/staff: return own shop
    if (!user.shopId) return c.json({ shops: [] });
    const shop = await prisma.shop.findUnique({ where: { id: user.shopId } });
    if (!shop || (shop as any).deletedAt) return c.json({ shops: [] });
    return c.json({ shops: [shop] });
  } catch (e) {
    const { toAppError: toAppErr } = await import("../lib/errors.js");
    const appErr = toAppErr(e);
    return c.json({ error: appErr.message, code: appErr.code }, appErr.status as 400 | 401 | 403 | 404 | 409 | 500 | 503);
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
    const { toAppError: toAppErr } = await import("../lib/errors.js");
    const appErr = toAppErr(e);
    return c.json({ error: appErr.message, code: appErr.code }, appErr.status as 400 | 401 | 403 | 404 | 409 | 500 | 503);
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
    const receipt = receiptFields(body);
    if (typeof receipt === "string") return c.json({ error: receipt }, 400);
    const shop = await prisma.shop.create({ data: { name, address, code: await allocateShopCode(), ...receipt } });
    await prisma.shopOrderSeq.upsert({ where: { shopId: shop.id }, update: {}, create: { shopId: shop.id, lastNo: 0 } });
    return c.json({ shop }, 201);
  } catch (e) {
    const { toAppError: toAppErr } = await import("../lib/errors.js");
    const appErr = toAppErr(e);
    return c.json({ error: appErr.message, code: appErr.code }, appErr.status as 400 | 401 | 403 | 404 | 409 | 500 | 503);
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
    if (body.code !== undefined) return c.json({ error: "Shop code is auto-assigned and cannot be changed" }, 400);
    const data: Record<string, unknown> = {};
    if (body.name !== undefined) {
      const n = String(body.name).trim();
      if (!n) return c.json({ error: "Name required" }, 400);
      data.name = n;
    }
    if (body.address !== undefined) data.address = body.address ? String(body.address).trim().slice(0, 500) : null;
    if (body.isActive !== undefined) {
      // Prevent self-lockout: SHOP_OWNER cannot deactivate their own shop.
      // Only SUPER_ADMIN can toggle isActive (staff/owner get 403 SHOP_DISABLED otherwise).
      if (user.role !== "SUPER_ADMIN") {
        return c.json({ error: "Forbidden — only admin can deactivate a shop", code: "FORBIDDEN" }, 403);
      }
      data.isActive = Boolean(body.isActive);
    }
    const receipt = receiptFields(body, true);
    if (typeof receipt === "string") return c.json({ error: receipt }, 400);
    Object.assign(data, receipt);
    if (Object.keys(data).length === 0) return c.json({ error: "No valid fields" }, 400);
    const shop = await prisma.shop.update({ where: { id }, data });
    return c.json({ shop });
  } catch (e) {
    const { toAppError: toAppErr } = await import("../lib/errors.js");
    const appErr = toAppErr(e);
    return c.json({ error: appErr.message, code: appErr.code }, appErr.status as 400 | 401 | 403 | 404 | 409 | 500 | 503);
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
    const { toAppError: toAppErr } = await import("../lib/errors.js");
    const appErr = toAppErr(e);
    return c.json({ error: appErr.message, code: appErr.code }, appErr.status as 400 | 401 | 403 | 404 | 409 | 500 | 503);
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
    const { toAppError: toAppErr } = await import("../lib/errors.js");
    const appErr = toAppErr(e);
    return c.json({ error: appErr.message, code: appErr.code }, appErr.status as 400 | 401 | 403 | 404 | 409 | 500 | 503);
  }
});

export default shops;
