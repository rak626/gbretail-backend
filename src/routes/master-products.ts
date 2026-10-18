import { Hono } from "hono";
import { Prisma } from "@prisma/client";
import { prisma } from "../lib/prisma.js";
import { getShopScope } from "../lib/shopScope.js";
import { requireAuth, requireRole } from "../middleware/auth.js";
import { parseMoney, MAX_MONEY } from "../lib/money.js";
import { toAppError } from "../lib/errors.js";

const masterProducts = new Hono();

masterProducts.use("*", requireAuth as any);

// GET /api/master-products — SUPER_ADMIN sees all, others see enabled ones
masterProducts.get("/", async (c) => {
  const user = (c as any).get("user") as any;
  const search = (c.req.query("search") ?? "").trim();
  const category = c.req.query("category") ?? "All";
  const isActive = c.req.query("isActive");
  const rawLimit = parseInt(c.req.query("limit") ?? "100", 10);
  const limit = isNaN(rawLimit) ? 100 : Math.min(Math.max(rawLimit, 1), 500);
  const rawPage = parseInt(c.req.query("page") ?? "1", 10);
  const page = isNaN(rawPage) ? 1 : Math.max(rawPage, 1);

  try {
    // Only SUPER_ADMIN can list all master products; others see active ones
    if (user.role !== "SUPER_ADMIN") {
      return c.json({ error: "Forbidden — SUPER_ADMIN only", code: "FORBIDDEN" }, 403);
    }

    const where: Record<string, unknown> = { deletedAt: null };
    if (search) {
      where.OR = [
        { name: { contains: search, mode: "insensitive" as const } },
        { barcode: { contains: search, mode: "insensitive" as const } },
        { brand: { contains: search, mode: "insensitive" as const } },
      ];
    }
    if (category && category !== "All") {
      where.category = category;
    }
    if (isActive !== undefined) {
      where.isActive = isActive === "true";
    }

    const [items, total] = await Promise.all([
      prisma.masterProduct.findMany({
        where,
        orderBy: [{ name: "asc" }],
        take: limit,
        skip: (page - 1) * limit,
      }),
      prisma.masterProduct.count({ where }),
    ]);

    return c.json({ masterProducts: items, total, page, limit });
  } catch (e) {
    const appErr = toAppError(e);
    return c.json({ error: appErr.message, code: appErr.code }, appErr.status as 400 | 404 | 409 | 500 | 503);
  }
});

// GET /api/master-products/:id
masterProducts.get("/:id", async (c) => {
  const user = (c as any).get("user") as any;
  const id = c.req.param("id");
  try {
    if (user.role !== "SUPER_ADMIN") {
      return c.json({ error: "Forbidden — SUPER_ADMIN only", code: "FORBIDDEN" }, 403);
    }
    const product = await prisma.masterProduct.findUnique({ where: { id } });
    if (!product || product.deletedAt) return c.json({ error: "Not found" }, 404);
    return c.json({ masterProduct: product });
  } catch (e) {
    const appErr = toAppError(e);
    return c.json({ error: appErr.message, code: appErr.code }, appErr.status as 400 | 404 | 409 | 500 | 503);
  }
});

// POST /api/master-products — create a master product (SUPER_ADMIN only)
masterProducts.post("/", async (c) => {
  const user = (c as any).get("user") as any;
  try {
    if (user.role !== "SUPER_ADMIN") {
      return c.json({ error: "Forbidden — SUPER_ADMIN only", code: "FORBIDDEN" }, 403);
    }
    const body = await c.req.json();
    const { name, category, brand, barcode, is_loose, unit, basePrice, imageUrl, preset_weights, preset_prices } = body as any;

    if (!name || !category) {
      return c.json({ error: "name and category required" }, 400);
    }
    if (name.length > 200) return c.json({ error: "Name too long (max 200)" }, 400);
    if (category.length > 100) return c.json({ error: "Category too long (max 100)" }, 400);

    if (barcode) {
      const trimmed = String(barcode).trim();
      const existing = await prisma.masterProduct.findUnique({ where: { barcode: trimmed } });
      if (existing) return c.json({ error: "Barcode already exists", code: "BARCODE_TAKEN" }, 409);
    }

    let bp: number | null = null;
    if (basePrice != null && String(basePrice).trim() !== "") {
      bp = parseMoney(basePrice);
      if (isNaN(bp) || bp < 0 || bp > MAX_MONEY) return c.json({ error: "Invalid basePrice" }, 400);
    }

    const product = await prisma.masterProduct.create({
      data: {
        name: String(name).trim(),
        category: String(category).trim(),
        brand: brand ? String(brand).trim().slice(0, 100) : null,
        barcode: barcode ? String(barcode).trim() : null,
        is_loose: Boolean(is_loose),
        unit: unit ? String(unit) : "pcs",
        basePrice: bp,
        imageUrl: imageUrl ? String(imageUrl).trim().slice(0, 500) : null,
        preset_weights: Array.isArray(preset_weights) ? (preset_weights as unknown[]).map(Number).filter((n) => !isNaN(n)) : [],
        preset_prices: Array.isArray(preset_prices) ? (preset_prices as unknown[]).map((v) => parseMoney(v)).filter((n) => !isNaN(n)) : [],
      },
    });
    return c.json({ masterProduct: product }, 201);
  } catch (e) {
    const appErr = toAppError(e);
    return c.json({ error: appErr.message, code: appErr.code }, appErr.status as 400 | 404 | 409 | 500 | 503);
  }
});

// PATCH /api/master-products/:id — update master product (SUPER_ADMIN only)
masterProducts.patch("/:id", async (c) => {
  const user = (c as any).get("user") as any;
  const id = c.req.param("id");
  try {
    if (user.role !== "SUPER_ADMIN") {
      return c.json({ error: "Forbidden — SUPER_ADMIN only", code: "FORBIDDEN" }, 403);
    }
    const existing = await prisma.masterProduct.findUnique({ where: { id } });
    if (!existing || existing.deletedAt) return c.json({ error: "Not found" }, 404);

    const body = await c.req.json();
    const data: Record<string, unknown> = {};
    const fields = ["name", "category", "brand", "barcode", "is_loose", "unit", "basePrice", "imageUrl", "preset_weights", "preset_prices", "isActive"] as const;
    for (const k of fields) if (k in body) data[k] = (body as Record<string, unknown>)[k];

    if (data.barcode != null) {
      const b = String(data.barcode).trim() || null;
      if (b) {
        const clash = await prisma.masterProduct.findFirst({ where: { barcode: b } });
        if (clash && clash.id !== id) return c.json({ error: "Barcode already exists", code: "BARCODE_TAKEN" }, 409);
      }
      data.barcode = b;
    }
    if (data.basePrice != null) {
      if (data.basePrice == null || String(data.basePrice).trim() === "") data.basePrice = null;
      else {
        const bp = parseMoney(data.basePrice);
        if (isNaN(bp) || bp < 0 || bp > MAX_MONEY) return c.json({ error: "Invalid basePrice" }, 400);
        data.basePrice = bp;
      }
    }
    if (data.name != null) data.name = String(data.name).trim();
    if (data.category != null) data.category = String(data.category).trim();
    if (data.brand != null) data.brand = String(data.brand).trim() || null;
    if (data.is_loose != null) data.is_loose = Boolean(data.is_loose);
    if (data.unit != null) data.unit = String(data.unit);
    if (data.imageUrl != null) data.imageUrl = String(data.imageUrl).trim().slice(0, 500) || null;
    if (data.preset_weights != null) data.preset_weights = Array.isArray(data.preset_weights) ? (data.preset_weights as unknown[]).map(Number).filter((n: number) => !isNaN(n)) : [];
    if (data.preset_prices != null) data.preset_prices = Array.isArray(data.preset_prices) ? (data.preset_prices as unknown[]).map((v: unknown) => parseMoney(v)).filter((n: number) => !isNaN(n)) : [];
    if (data.isActive != null) data.isActive = Boolean(data.isActive);

    if (Object.keys(data).length === 0) return c.json({ error: "No valid fields" }, 400);

    const product = await prisma.masterProduct.update({ where: { id }, data });
    return c.json({ masterProduct: product });
  } catch (e) {
    const appErr = toAppError(e);
    return c.json({ error: appErr.message, code: appErr.code }, appErr.status as 400 | 404 | 409 | 500 | 503);
  }
});

// DELETE /api/master-products/:id — soft delete (SUPER_ADMIN only)
masterProducts.delete("/:id", async (c) => {
  const user = (c as any).get("user") as any;
  const id = c.req.param("id");
  try {
    if (user.role !== "SUPER_ADMIN") {
      return c.json({ error: "Forbidden — SUPER_ADMIN only", code: "FORBIDDEN" }, 403);
    }
    const existing = await prisma.masterProduct.findUnique({ where: { id } });
    if (!existing || existing.deletedAt) return c.json({ error: "Not found" }, 404);

    // Block if any shop product references it
    const refs = await prisma.shopProduct.findFirst({ where: { masterProductId: id, deletedAt: null } });
    if (refs) return c.json({ error: "Master product is referenced by shop products — disable them first", code: "REFERENCED" }, 409);

    const product = await prisma.masterProduct.update({ where: { id }, data: { deletedAt: new Date(), isActive: false } });
    return c.json({ success: true, softDeleted: true, masterProduct: product });
  } catch (e) {
    const appErr = toAppError(e);
    return c.json({ error: appErr.message, code: appErr.code }, appErr.status as 400 | 404 | 409 | 500 | 503);
  }
});

// POST /api/master-products/batch — bulk import (≤500 rows)
masterProducts.post("/batch", async (c) => {
  const user = (c as any).get("user") as any;
  try {
    if (user.role !== "SUPER_ADMIN") {
      return c.json({ error: "Forbidden — SUPER_ADMIN only", code: "FORBIDDEN" }, 403);
    }
    const body = await c.req.json();
    const items = (body as any).items;
    if (!Array.isArray(items) || items.length === 0) return c.json({ error: "items[] required" }, 400);
    if (items.length > 500) return c.json({ error: "Max 500 rows per batch" }, 400);

    const errors: Array<{ index: number; error: string }> = [];
    const prepared: Array<Record<string, unknown>> = [];
    const seenBarcodes = new Set<string>();

    for (let i = 0; i < items.length; i++) {
      const r = items[i] as any;
      const name = String(r.name ?? "").trim();
      const category = String(r.category ?? "").trim();
      if (!name || !category) { errors.push({ index: i, error: "name and category required" }); continue; }
      if (name.length > 200) { errors.push({ index: i, error: "Name too long" }); continue; }
      if (category.length > 100) { errors.push({ index: i, error: "Category too long" }); continue; }

      const barcode = r.barcode ? String(r.barcode).trim() : null;
      if (barcode) {
        if (seenBarcodes.has(barcode)) { errors.push({ index: i, error: `duplicate barcode in batch: ${barcode}` }); continue; }
        seenBarcodes.add(barcode);
      }

      let bp: number | null = null;
      if (r.basePrice != null && String(r.basePrice).trim() !== "") {
        bp = parseMoney(r.basePrice);
        if (isNaN(bp) || bp < 0 || bp > MAX_MONEY) { errors.push({ index: i, error: "invalid basePrice" }); continue; }
      }

      prepared.push({
        name,
        category,
        brand: r.brand ? String(r.brand).trim().slice(0, 100) : null,
        barcode,
        is_loose: Boolean(r.is_loose),
        unit: r.unit ? String(r.unit) : "pcs",
        basePrice: bp,
        imageUrl: r.imageUrl ? String(r.imageUrl).trim().slice(0, 500) : null,
        preset_weights: Array.isArray(r.preset_weights) ? r.preset_weights.map(Number).filter((n: number) => !isNaN(n)) : [],
        preset_prices: Array.isArray(r.preset_prices) ? r.preset_prices.map((v: unknown) => parseMoney(v)).filter((n: number) => !isNaN(n)) : [],
      });
    }
    if (errors.length) return c.json({ error: "Batch validation failed", errors }, 400);

    // DB barcode clash check
    if (seenBarcodes.size) {
      const existing = await prisma.masterProduct.findMany({ where: { barcode: { in: [...seenBarcodes] }, deletedAt: null }, select: { barcode: true } });
      if (existing.length) {
        return c.json({ error: "Barcode already exists", barcodes: existing.map((e: any) => e.barcode) }, 409);
      }
    }

    const created = await prisma.$transaction(async (tx) => {
      const out = [];
      for (const d of prepared) out.push(await tx.masterProduct.create({ data: d as any }));
      return out;
    });
    return c.json({ masterProducts: created, count: created.length }, 201);
  } catch (e) {
    const appErr = toAppError(e);
    return c.json({ error: appErr.message, code: appErr.code }, appErr.status as 400 | 404 | 409 | 500 | 503);
  }
});

export default masterProducts;
