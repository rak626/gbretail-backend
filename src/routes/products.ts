import { Hono } from "hono";
import { prisma } from "../lib/prisma.js";
import { products as staticProducts } from "../data/products.js";

const products = new Hono();

// GET /api/products?search&category&limit
products.get("/", async (c) => {
  const search = (c.req.query("search") ?? "").toLowerCase();
  const category = c.req.query("category") ?? "All";
  const limit = parseInt(c.req.query("limit") ?? "100", 10);

  try {
    const where: Record<string, unknown> = {};
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
    console.warn("[GET /products] DB fallback to static:", e instanceof Error ? e.message : e);
    let filtered = staticProducts as unknown as Array<Record<string, unknown>>;
    if (search) {
      filtered = filtered.filter(
        (p) => String(p.name).toLowerCase().includes(search) || String(p.barcode ?? "").includes(search)
      );
    }
    if (category && category !== "All") {
      if (category === "Loose Items") filtered = filtered.filter((p) => p.is_loose);
      else filtered = filtered.filter((p) => p.category === category);
    }
    return c.json({ products: filtered.slice(0, limit), source: "static" });
  }
});

// GET /api/products/:id
products.get("/:id", async (c) => {
  const id = c.req.param("id");
  try {
    const product = await prisma.product.findUnique({ where: { id } });
    if (!product) return c.json({ error: "Not found" }, 404);
    return c.json({ product });
  } catch (e) {
    return c.json({ error: e instanceof Error ? e.message : "Error" }, 500);
  }
});

// POST /api/products
products.post("/", async (c) => {
  try {
    const body = await c.req.json();
    const { id, name, is_loose, rate_per_kg, barcode, price, costPrice, unit, category, preset_weights, preset_prices, stockQuantity } = body;

    if (!name || !category) {
      return c.json({ error: "name and category required" }, 400);
    }
    if (costPrice == null || isNaN(Number(costPrice)) || Number(costPrice) < 0) {
      return c.json({ error: "costPrice (buying price) is required and must be >=0" }, 400);
    }
    if (is_loose) {
      if (rate_per_kg == null || isNaN(Number(rate_per_kg)) || Number(rate_per_kg) <= 0) {
        return c.json({ error: "rate_per_kg required for loose" }, 400);
      }
    } else {
      if (price == null || isNaN(Number(price)) || Number(price) < 0) {
        return c.json({ error: "price required for packaged" }, 400);
      }
    }

    if (barcode) {
      const existing = await prisma.product.findUnique({ where: { barcode } });
      if (existing && existing.id !== id) {
        return c.json({ error: "Barcode already exists" }, 409);
      }
    }

    const data = {
      name: String(name).trim(),
      is_loose: Boolean(is_loose),
      rate_per_kg: rate_per_kg != null ? Number(rate_per_kg) : null,
      barcode: barcode ? String(barcode).trim() : null,
      price: price != null ? Number(price) : null,
      costPrice: Number(costPrice),
      unit: unit ? String(unit) : "pcs",
      category: String(category),
      preset_weights: Array.isArray(preset_weights) ? preset_weights.map(Number) : [],
      preset_prices: Array.isArray(preset_prices) ? preset_prices.map(Number) : [],
      stockQuantity: stockQuantity != null ? Number(stockQuantity) : 100,
    };

    let product;
    if (id) {
      product = await prisma.product.upsert({
        where: { id },
        update: data,
        create: { id, ...data },
      });
    } else {
      product = await prisma.product.create({ data });
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
  try {
    const body = await c.req.json();
    const allowed: Record<string, unknown> = {};
    const fields = ["name", "is_loose", "rate_per_kg", "barcode", "price", "costPrice", "unit", "category", "preset_weights", "preset_prices", "stockQuantity"] as const;
    for (const k of fields) if (k in body) allowed[k] = (body as Record<string, unknown>)[k];

    if (allowed.costPrice != null) {
      const cp = Number(allowed.costPrice);
      if (isNaN(cp) || cp < 0) return c.json({ error: "costPrice must be >=0" }, 400);
      allowed.costPrice = cp;
    }
    if (allowed.price != null) allowed.price = Number(allowed.price as number);
    if (allowed.rate_per_kg != null) allowed.rate_per_kg = Number(allowed.rate_per_kg as number);
    if (allowed.stockQuantity != null) allowed.stockQuantity = Number(allowed.stockQuantity as number);
    if (allowed.name != null) allowed.name = String(allowed.name).trim();
    if (allowed.category != null) allowed.category = String(allowed.category);
    if (allowed.barcode != null) allowed.barcode = allowed.barcode ? String(allowed.barcode).trim() : null;
    if (allowed.unit != null) allowed.unit = String(allowed.unit);
    if (allowed.preset_weights != null) allowed.preset_weights = Array.isArray(allowed.preset_weights) ? (allowed.preset_weights as unknown[]).map(Number) : [];
    if (allowed.preset_prices != null) allowed.preset_prices = Array.isArray(allowed.preset_prices) ? (allowed.preset_prices as unknown[]).map(Number) : [];

    if (Object.keys(allowed).length === 0) return c.json({ error: "No valid fields to update" }, 400);

    // Barcode uniqueness guard
    if (allowed.barcode) {
      const dup = await prisma.product.findUnique({ where: { barcode: String(allowed.barcode) } });
      if (dup && dup.id !== id) return c.json({ error: "Barcode already exists" }, 409);
    }

    const product = await prisma.product.update({ where: { id }, data: allowed });
    return c.json({ product });
  } catch (e) {
    const { toAppError } = await import("../lib/errors.js");
    const appErr = toAppError(e);
    return c.json({ error: appErr.message, code: appErr.code }, appErr.status as 400 | 404 | 409 | 500 | 503);
  }
});

// DELETE /api/products/:id
products.delete("/:id", async (c) => {
  const id = c.req.param("id");
  try {
    await prisma.product.delete({ where: { id } });
    return c.json({ success: true });
  } catch (e) {
    return c.json({ error: e instanceof Error ? e.message : "Error" }, 500);
  }
});

export default products;
