import { Hono } from "hono";
import { Prisma } from "@prisma/client";
import { prisma } from "../lib/prisma.js";
import { getShopScope } from "../lib/shopScope.js";
import { requireAuth } from "../middleware/auth.js";
import { parseMoney, MAX_MONEY } from "../lib/money.js";
import { toAppError } from "../lib/errors.js";

const shopProducts = new Hono();

shopProducts.use("*", requireAuth as any);

// GET /api/shop-products — list products for the user's shop
shopProducts.get("/", async (c) => {
  const user = (c as any).get("user") as any;
  const { shopId } = getShopScope(c);
  const search = (c.req.query("search") ?? "").trim();
  const category = c.req.query("category") ?? "All";
  const isEnabled = c.req.query("isEnabled");
  const isOnline = c.req.query("isOnline");
  const rawLimit = parseInt(c.req.query("limit") ?? "100", 10);
  const limit = isNaN(rawLimit) ? 100 : Math.min(Math.max(rawLimit, 1), 500);
  const rawPage = parseInt(c.req.query("page") ?? "1", 10);
  const page = isNaN(rawPage) ? 1 : Math.max(rawPage, 1);

  try {
    if (!shopId && user.role !== "SUPER_ADMIN") return c.json({ error: "Shop not assigned" }, 403);

    const where: Record<string, unknown> = { deletedAt: null };
    if (user.role !== "SUPER_ADMIN") {
      where.shopId = shopId;
    }
    if (search) {
      where.OR = [
        { masterProduct: { name: { contains: search, mode: "insensitive" as const } } },
        { masterProduct: { barcode: { contains: search, mode: "insensitive" as const } } },
        { masterProduct: { brand: { contains: search, mode: "insensitive" as const } } },
        { shopBarcode: { contains: search, mode: "insensitive" as const } },
      ];
    }
    if (category && category !== "All") {
      where.masterProduct = { ...(where.masterProduct as object), category } as any;
    }
    if (isEnabled !== undefined) where.isEnabled = isEnabled === "true";
    if (isOnline !== undefined) where.isOnline = isOnline === "true";

    const [items, total] = await Promise.all([
      prisma.shopProduct.findMany({
        where,
        include: { masterProduct: true },
        orderBy: [{ masterProduct: { name: "asc" } }],
        take: limit,
        skip: (page - 1) * limit,
      }),
      prisma.shopProduct.count({ where }),
    ]);

    return c.json({ shopProducts: items, total, page, limit });
  } catch (e) {
    const appErr = toAppError(e);
    return c.json({ error: appErr.message, code: appErr.code }, appErr.status as 400 | 404 | 409 | 500 | 503);
  }
});

// GET /api/shop-products/master/:masterProductId — see all shops carrying a master product (SUPER_ADMIN)
shopProducts.get("/master/:masterProductId", async (c) => {
  const user = (c as any).get("user") as any;
  const masterProductId = c.req.param("masterProductId");
  try {
    if (user.role !== "SUPER_ADMIN") return c.json({ error: "Forbidden — SUPER_ADMIN only", code: "FORBIDDEN" }, 403);
    const items = await prisma.shopProduct.findMany({
      where: { masterProductId, deletedAt: null },
      include: { shop: { select: { id: true, name: true, code: true } } },
      orderBy: [{ shop: { name: "asc" } }],
    });
    return c.json({ shopProducts: items });
  } catch (e) {
    const appErr = toAppError(e);
    return c.json({ error: appErr.message, code: appErr.code }, appErr.status as 400 | 404 | 409 | 500 | 503);
  }
});

// PATCH /api/shop-products/:id — update shop product (enable/disable, price, stock)
shopProducts.patch("/:id", async (c) => {
  const user = (c as any).get("user") as any;
  const { shopId } = getShopScope(c);
  const id = c.req.param("id");
  try {
    const existing = await prisma.shopProduct.findUnique({ where: { id }, include: { masterProduct: true } });
    if (!existing || existing.deletedAt) return c.json({ error: "Not found" }, 404);
    if (user.role !== "SUPER_ADMIN" && existing.shopId !== shopId) return c.json({ error: "Forbidden", code: "FORBIDDEN" }, 403);

    const body = await c.req.json();
    const data: Record<string, unknown> = {};

    if (body.isEnabled != null) data.isEnabled = Boolean(body.isEnabled);
    if (body.isOnline != null) data.isOnline = Boolean(body.isOnline);

    if (body.shopPrice != null) {
      if (body.shopPrice == null || String(body.shopPrice).trim() === "") data.shopPrice = null;
      else {
        const p = parseMoney(body.shopPrice);
        if (isNaN(p) || p < 0 || p > MAX_MONEY) return c.json({ error: "Invalid shopPrice" }, 400);
        data.shopPrice = p;
      }
    }
    if (body.costPrice != null) {
      const cp = parseMoney(body.costPrice);
      if (isNaN(cp) || cp < 0 || cp > MAX_MONEY) return c.json({ error: "Invalid costPrice" }, 400);
      data.costPrice = cp;
    }
    if (body.stockQuantity != null) {
      const sq = Number(body.stockQuantity);
      if (isNaN(sq) || sq < 0) return c.json({ error: "stockQuantity must be >=0" }, 400);
      data.stockQuantity = sq;
    }
    if (body.lowStockThreshold != null) {
      const lt = Number(body.lowStockThreshold);
      if (isNaN(lt) || lt < 0) return c.json({ error: "lowStockThreshold must be >=0" }, 400);
      data.lowStockThreshold = lt;
    }
    if (body.shopBarcode != null) data.shopBarcode = body.shopBarcode ? String(body.shopBarcode).trim() : null;
    if (body.onlinePrice != null) {
      if (body.onlinePrice == null || String(body.onlinePrice).trim() === "") data.onlinePrice = null;
      else {
        const op = parseMoney(body.onlinePrice);
        if (isNaN(op) || op < 0 || op > MAX_MONEY) return c.json({ error: "Invalid onlinePrice" }, 400);
        data.onlinePrice = op;
      }
    }

    if (Object.keys(data).length === 0) return c.json({ error: "No valid fields" }, 400);

    const product = await prisma.shopProduct.update({ where: { id }, data });
    return c.json({ shopProduct: product });
  } catch (e) {
    const appErr = toAppError(e);
    return c.json({ error: appErr.message, code: appErr.code }, appErr.status as 400 | 404 | 409 | 500 | 503);
  }
});

// DELETE /api/shop-products/:id — soft delete (owner/SUPER_ADMIN)
shopProducts.delete("/:id", async (c) => {
  const user = (c as any).get("user") as any;
  const { shopId } = getShopScope(c);
  const id = c.req.param("id");
  try {
    const existing = await prisma.shopProduct.findUnique({ where: { id } });
    if (!existing || existing.deletedAt) return c.json({ error: "Not found" }, 404);
    if (user.role !== "SUPER_ADMIN" && existing.shopId !== shopId) return c.json({ error: "Forbidden", code: "FORBIDDEN" }, 403);

    // Block if there are order items referencing it
    const refs = await prisma.orderItem.findFirst({ where: { shopProductId: id } });
    if (refs) return c.json({ error: "Shop product is referenced by orders — disable instead", code: "REFERENCED" }, 409);

    const product = await prisma.shopProduct.update({ where: { id }, data: { deletedAt: new Date(), isEnabled: false } });
    return c.json({ success: true, softDeleted: true, shopProduct: product });
  } catch (e) {
    const appErr = toAppError(e);
    return c.json({ error: appErr.message, code: appErr.code }, appErr.status as 400 | 404 | 409 | 500 | 503);
  }
});

// POST /api/shop-products — enable a master product at this shop (owner/SUPER_ADMIN)
shopProducts.post("/", async (c) => {
  const user = (c as any).get("user") as any;
  const { shopId } = getShopScope(c);
  try {
    if (!shopId && user.role !== "SUPER_ADMIN") return c.json({ error: "Shop not assigned" }, 403);
    if (user.role === "SUPER_ADMIN" && !shopId) return c.json({ error: "shopId required for SUPER_ADMIN" }, 400);

    const body = await c.req.json();
    const { masterProductId, shopPrice, costPrice, stockQuantity, lowStockThreshold, shopBarcode, isOnline, onlinePrice } = body as Record<string, unknown>;

    if (!masterProductId) return c.json({ error: "masterProductId required" }, 400);

    const master = await prisma.masterProduct.findUnique({
      where: { id: String(masterProductId) },
    });
    if (!master || master.deletedAt || !master.isActive) return c.json({ error: "Master product not found or inactive", code: "NOT_FOUND" }, 404);

    // Check if already enabled at this shop
    const existing = await prisma.shopProduct.findFirst({ where: { shopId: shopId!, masterProductId: String(masterProductId), deletedAt: null } });
    if (existing) return c.json({ error: "Product already enabled at this shop", code: "ALREADY_ENABLED", shopProduct: existing }, 409);

    let sp: number | null = null;
    if (shopPrice != null && String(shopPrice).trim() !== "") {
      sp = parseMoney(shopPrice);
      if (isNaN(sp) || sp < 0 || sp > MAX_MONEY) return c.json({ error: "Invalid shopPrice" }, 400);
    }
    let cp: number;
    if (costPrice != null) {
      cp = parseMoney(costPrice);
      if (isNaN(cp) || cp < 0 || cp > MAX_MONEY) return c.json({ error: "Invalid costPrice" }, 400);
    } else {
      cp = Number(master.basePrice ?? 0);
    }
    let sq = 0;
    if (stockQuantity != null) {
      sq = Number(stockQuantity);
      if (isNaN(sq) || sq < 0) return c.json({ error: "stockQuantity must be >=0" }, 400);
    }
    let lt = 10;
    if (lowStockThreshold != null) {
      lt = Number(lowStockThreshold);
      if (isNaN(lt) || lt < 0) return c.json({ error: "lowStockThreshold must be >=0" }, 400);
    }

    const product = await prisma.shopProduct.create({
      data: {
        shopId: shopId!,
        masterProductId: String(masterProductId),
        isEnabled: true,
        shopPrice: sp,
        costPrice: cp,
        stockQuantity: sq,
        lowStockThreshold: lt,
        shopBarcode: shopBarcode ? String(shopBarcode).trim() : null,
        isOnline: Boolean(isOnline),
        onlinePrice: onlinePrice != null && String(onlinePrice).trim() !== "" ? parseMoney(onlinePrice) : null,
      },
      include: { masterProduct: true },
    });
    return c.json({ shopProduct: product }, 201);
  } catch (e) {
    const appErr = toAppError(e);
    return c.json({ error: appErr.message, code: appErr.code }, appErr.status as 400 | 404 | 409 | 500 | 503);
  }
});

export default shopProducts;
