import { Hono } from "hono";
import { prisma } from "../lib/prisma.js";
import { requireAuth } from "../middleware/auth.js";
import { parseMoney, MAX_MONEY } from "../lib/money.js";

const products = new Hono();

products.use("*", requireAuth as any);

// STAFF can only mutate inventory when the owner granted canManageInventory.
// Checked fresh from DB (not the token) so owner revoke/grant applies immediately.
async function staffInventoryDenied(c: unknown): Promise<boolean> {
  const user = ((c as any).get("user" as any) as any) || {};
  if (!user || user.role !== "STAFF") return false;
  try {
    const row = await prisma.user.findUnique({ where: { id: user.userId }, select: { canManageInventory: true } as any });
    return !(row as any)?.canManageInventory;
  } catch {
    return true;
  }
}

// GET /api/products?search&category&limit&shopId
products.get("/", async (c) => {
  const search = (c.req.query("search") ?? "").toLowerCase();
  const category = c.req.query("category") ?? "All";
  const rawLimit = parseInt(c.req.query("limit") ?? "100", 10);
  const limit = isNaN(rawLimit) ? 100 : rawLimit;
  const user = (c as any).get("user" as any) as any;
  const shopId = ((c as any).get("shopId" as any) as string | null) || c.req.query("shopId") || user?.shopId || null;

  try {
    const where: Record<string, unknown> = { deletedAt: null };
    if (shopId) {
      (where as any).shopId = shopId;
    } else if (user?.role !== "SUPER_ADMIN") {
      return c.json({ error: "Shop not assigned — contact admin", code: "NO_SHOP" }, 403);
    }
    if (search) {
      where.OR = [
        { name: { contains: search, mode: "insensitive" as const } },
        { barcode: { contains: search } },
      ];
    }
    if (category && category !== "All") {
      if (category === "Loose Items") {
        (where as Record<string, unknown>).is_loose = true;
      } else {
        (where as Record<string, unknown>).category = category;
      }
    }

    const items = await prisma.product.findMany({
      where,
      orderBy: { name: "asc" },
      take: Math.min(limit, 200),
    });

    return c.json({ products: items, source: "db" });
  } catch (e) {
    // No hardcoded fallback: catalog is shop data and must come from the DB.
    // A failure here is honest (offline clients use their cached catalog).
    return c.json({ error: "Failed to load products" }, 500);
  }
});

// GET /api/products/:id
products.get("/:id", async (c) => {
  const id = c.req.param("id");
  const user = (c as any).get("user" as any) as any;
  const shopId = ((c as any).get("shopId" as any) as string | null) || user?.shopId || null;
  try {
    const product = await prisma.product.findUnique({ where: { id } });
    if (!product || (product as any).deletedAt) return c.json({ error: "Not found" }, 404);
    if (shopId && (product as any).shopId && (product as any).shopId !== shopId && user.role !== "SUPER_ADMIN") {
      return c.json({ error: "Forbidden — product belongs to another shop" }, 403);
    }
    if (!shopId && user.role !== "SUPER_ADMIN") return c.json({ error: "Shop not assigned" }, 403);
    return c.json({ product });
  } catch (e) {
    return c.json({ error: e instanceof Error ? e.message : "Error" }, 500);
  }
});

// POST /api/products
products.post("/", async (c) => {
  try {
    if (await staffInventoryDenied(c)) return c.json({ error: "Forbidden — inventory access not granted by owner" }, 403);
    const user = (c as any).get("user" as any) as any;
    const body = await c.req.json();
    let shopId: string | null = ((c as any).get("shopId" as any) as string | null) || user?.shopId || null;
    if (user.role === "SUPER_ADMIN" && (body as any).shopId) shopId = String((body as any).shopId);
    if (!shopId && user.role !== "SUPER_ADMIN") return c.json({ error: "Shop not assigned" }, 403);
    if (user.role === "SUPER_ADMIN" && !shopId) return c.json({ error: "shopId required for SUPER_ADMIN" }, 400);

    const { id, name, is_loose, rate_per_kg, barcode, price, costPrice, unit, category, preset_weights, preset_prices, stockQuantity, lowStockThreshold } = body as any;

    if (!name || !category) {
      return c.json({ error: "name and category required" }, 400);
    }
    if (costPrice == null || isNaN(Number(costPrice)) || Number(costPrice) < 0) {
      return c.json({ error: "costPrice (buying price) is required and must be >=0" }, 400);
    }
    const costRounded = parseMoney(costPrice);
    if (isNaN(costRounded) || costRounded > MAX_MONEY) return c.json({ error: "Invalid costPrice (max 2 decimals)" }, 400);
    if (is_loose) {
      if (rate_per_kg == null || isNaN(Number(rate_per_kg)) || Number(rate_per_kg) <= 0) {
        return c.json({ error: "rate_per_kg required for loose" }, 400);
      }
      const r = parseMoney(rate_per_kg);
      if (isNaN(r) || r <= 0 || r > MAX_MONEY) return c.json({ error: "Invalid rate_per_kg (max 2 decimals)" }, 400);
    } else {
      if (price == null || isNaN(Number(price)) || Number(price) < 0) {
        return c.json({ error: "price required for packaged" }, 400);
      }
      const p = parseMoney(price);
      if (isNaN(p) || p > MAX_MONEY) return c.json({ error: "Invalid price (max 2 decimals)" }, 400);
    }

    if (barcode) {
      const trimmed = String(barcode).trim();
      // per-shop barcode uniqueness (allow same barcode across shops)
      const existing = await prisma.product.findFirst({ where: { barcode: trimmed, shopId: shopId!, deletedAt: null } as any });
      if (existing && (existing as any).id !== id) {
        return c.json({ error: "Barcode already exists in this shop" }, 409);
      }
      // also global uniqueness fallback for old data where shopId null — check global
      if (!shopId) {
        const global = await prisma.product.findUnique({ where: { barcode: trimmed } } as any);
        if (global && (global as any).id !== id) return c.json({ error: "Barcode already exists" }, 409);
      }
    }

    const data: Record<string, unknown> = {
      shopId,
      name: String(name).trim(),
      is_loose: Boolean(is_loose),
      rate_per_kg: rate_per_kg != null ? parseMoney(rate_per_kg) : null,
      barcode: barcode ? String(barcode).trim() : null,
      price: price != null ? parseMoney(price) : null,
      costPrice: costRounded,
      unit: unit ? String(unit) : "pcs",
      category: String(category),
      preset_weights: Array.isArray(preset_weights) ? (preset_weights as unknown[]).map(Number).filter((n) => !isNaN(n)) : [],
      preset_prices: Array.isArray(preset_prices) ? (preset_prices as unknown[]).map((v) => parseMoney(v)).filter((n) => !isNaN(n)) : [],
      stockQuantity: stockQuantity != null ? Number(stockQuantity) : 100,
      lowStockThreshold: lowStockThreshold != null ? Number(lowStockThreshold) : 10,
    };

    // validate stockQuantity
    if ((data.stockQuantity as number) < 0) return c.json({ error: "stockQuantity cannot be negative" }, 400);
    if (isNaN(data.lowStockThreshold as number) || (data.lowStockThreshold as number) < 0) return c.json({ error: "lowStockThreshold must be >= 0" }, 400);
    if (data.preset_weights && (data.preset_weights as number[]).some((n) => n <= 0)) return c.json({ error: "preset_weights must be positive" }, 400);

    let product;
    if (id) {
      // check existing belongs to same shop
      const existing = await prisma.product.findUnique({ where: { id } });
      if (existing && (existing as any).shopId && (existing as any).shopId !== shopId && user.role !== "SUPER_ADMIN") {
        return c.json({ error: "Forbidden — cannot upsert product of another shop" }, 403);
      }
      product = await prisma.product.upsert({
        where: { id },
        update: data as any,
        create: { id, ...(data as any) },
      });
    } else {
      product = await prisma.product.create({ data: data as any });
    }

    return c.json({ product }, 201);
  } catch (e) {
    console.error("[POST /products]", e);
    const msg = e instanceof Error ? e.message : "Failed to create product";
    if (msg.includes("DATABASE_URL") || msg.includes("connect")) {
      return c.json({ error: "Database not configured. Set DATABASE_URL" }, 503);
    }
    return c.json({ error: msg }, 500);
  }
});

// PATCH /api/products/:id — whitelist to prevent mutating id/createdAt/deletedAt
products.patch("/:id", async (c) => {
  const id = c.req.param("id");
  const user = (c as any).get("user" as any) as any;
  const shopId = ((c as any).get("shopId" as any) as string | null) || user?.shopId || null;
  try {
    if (await staffInventoryDenied(c)) return c.json({ error: "Forbidden — inventory access not granted by owner" }, 403);
    const existing = await prisma.product.findUnique({ where: { id } });
    if (!existing || (existing as any).deletedAt) return c.json({ error: "Not found" }, 404);
    if (shopId && (existing as any).shopId && (existing as any).shopId !== shopId && user.role !== "SUPER_ADMIN") {
      return c.json({ error: "Forbidden" }, 403);
    }

    const body = await c.req.json();
    const allowed: Record<string, unknown> = {};
    const fields = ["name", "is_loose", "rate_per_kg", "barcode", "price", "costPrice", "unit", "category", "preset_weights", "preset_prices", "stockQuantity", "lowStockThreshold"] as const;
    for (const k of fields) if (k in body) allowed[k] = (body as Record<string, unknown>)[k];

    if (allowed.costPrice != null) {
      const cp = parseMoney(allowed.costPrice);
      if (isNaN(cp) || cp < 0 || cp > MAX_MONEY) return c.json({ error: "costPrice must be >=0 (max 2 decimals)" }, 400);
      allowed.costPrice = cp;
    }
    if (allowed.price != null) {
      const p = parseMoney(allowed.price as number);
      if (isNaN(p) || p < 0 || p > MAX_MONEY) return c.json({ error: "Invalid price (max 2 decimals)" }, 400);
      allowed.price = p;
    }
    if (allowed.rate_per_kg != null) {
      const r = parseMoney(allowed.rate_per_kg as number);
      if (isNaN(r) || r <= 0 || r > MAX_MONEY) return c.json({ error: "Invalid rate_per_kg (max 2 decimals)" }, 400);
      allowed.rate_per_kg = r;
    }
    if (allowed.stockQuantity != null) {
      const sq = Number(allowed.stockQuantity as number);
      if (isNaN(sq) || sq < 0) return c.json({ error: "stockQuantity must be >=0" }, 400);
      allowed.stockQuantity = sq;
    }
    if (allowed.lowStockThreshold != null) {
      const lt = Number(allowed.lowStockThreshold as number);
      if (isNaN(lt) || lt < 0) return c.json({ error: "lowStockThreshold must be >= 0" }, 400);
      allowed.lowStockThreshold = lt;
    }
    if (allowed.name != null) allowed.name = String(allowed.name).trim();
    if (allowed.category != null) allowed.category = String(allowed.category);
    if (allowed.barcode != null) allowed.barcode = allowed.barcode ? String(allowed.barcode).trim() : null;
    if (allowed.unit != null) allowed.unit = String(allowed.unit);
    if (allowed.preset_weights != null) allowed.preset_weights = Array.isArray(allowed.preset_weights) ? (allowed.preset_weights as unknown[]).map(Number).filter((n) => !isNaN(n)) : [];
    if (allowed.preset_prices != null) allowed.preset_prices = Array.isArray(allowed.preset_prices) ? (allowed.preset_prices as unknown[]).map((v) => parseMoney(v)).filter((n) => !isNaN(n)) : [];

    if (Object.keys(allowed).length === 0) return c.json({ error: "No valid fields to update" }, 400);

    // Barcode uniqueness guard per shop
    if (allowed.barcode) {
      const trimmed = String(allowed.barcode);
      const dup = await prisma.product.findFirst({ where: { barcode: trimmed, shopId: (existing as any).shopId, deletedAt: null } as any });
      if (dup && (dup as any).id !== id) return c.json({ error: "Barcode already exists in this shop" }, 409);
    }

    const product = await prisma.product.update({ where: { id }, data: allowed as any });
    return c.json({ product });
  } catch (e) {
    const { toAppError } = await import("../lib/errors.js");
    const appErr = toAppError(e);
    return c.json({ error: appErr.message, code: appErr.code }, appErr.status as 400 | 404 | 409 | 500 | 503);
  }
});

// DELETE /api/products/:id — always soft delete
products.delete("/:id", async (c) => {
  const id = c.req.param("id");
  const user = (c as any).get("user" as any) as any;
  const shopId = ((c as any).get("shopId" as any) as string | null) || user?.shopId || null;
  try {
    if (await staffInventoryDenied(c)) return c.json({ error: "Forbidden — inventory access not granted by owner" }, 403);
    const existing = await prisma.product.findUnique({ where: { id } });
    if (!existing) return c.json({ error: "Not found" }, 404);
    if ((existing as any).deletedAt) return c.json({ error: "Already deleted" }, 409);
    if (shopId && (existing as any).shopId && (existing as any).shopId !== shopId && user.role !== "SUPER_ADMIN") {
      return c.json({ error: "Forbidden" }, 403);
    }
    // Check if product has orderItems (history) — still allow soft delete
    const product = await prisma.product.update({ where: { id }, data: { deletedAt: new Date() } as any });
    return c.json({ success: true, softDeleted: true, product });
  } catch (e) {
    return c.json({ error: e instanceof Error ? e.message : "Error" }, 500);
  }
});

// POST /api/products/:id/restore
products.post("/:id/restore", async (c) => {
  const id = c.req.param("id");
  const user = (c as any).get("user" as any) as any;
  const shopId = ((c as any).get("shopId" as any) as string | null) || user?.shopId || null;
  try {
    if (await staffInventoryDenied(c)) return c.json({ error: "Forbidden — inventory access not granted by owner" }, 403);
    const existing = await prisma.product.findUnique({ where: { id } });
    if (!existing) return c.json({ error: "Not found" }, 404);
    if (!(existing as any).deletedAt) return c.json({ product: existing, message: "Already active" });
    if (shopId && (existing as any).shopId && (existing as any).shopId !== shopId && user.role !== "SUPER_ADMIN") {
      return c.json({ error: "Forbidden" }, 403);
    }
    const product = await prisma.product.update({ where: { id }, data: { deletedAt: null } as any });
    return c.json({ product });
  } catch (e) {
    return c.json({ error: e instanceof Error ? e.message : "Error" }, 500);
  }
});

export default products;
