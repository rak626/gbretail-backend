import { Hono } from "hono";
import { prisma } from "../lib/prisma.js";
import { getShopScope } from "../lib/shopScope.js";
import { requireAuth } from "../middleware/auth.js";
import { parseMoney, dec } from "../lib/money.js";

const transfers = new Hono();

transfers.use("*", requireAuth as any);

// Helper: check if user can see/manage a transfer (fromShop or toShop = user's shop, or SUPER_ADMIN)
async function transferAccessible(c: any, transfer: any): Promise<boolean> {
  const user = (c as any).get("user") as any;
  const { shopId } = getShopScope(c);
  if (user.role === "SUPER_ADMIN") return true;
  if (!shopId) return false;
  return transfer.fromShopId === shopId || transfer.toShopId === shopId;
}

// GET /api/transfers?status=&fromShopId=&toShopId=&limit=
transfers.get("/", async (c) => {
  const user = (c as any).get("user") as any;
  const { shopId } = getShopScope(c);
  const statusQ = (c.req.query("status") ?? "").trim();
  const fromShopIdQ = c.req.query("fromShopId");
  const toShopIdQ = c.req.query("toShopId");
  const rawLimit = parseInt(c.req.query("limit") ?? "50", 10);
  const limit = isNaN(rawLimit) ? 50 : Math.min(Math.max(rawLimit, 1), 100);

  try {
    if (!shopId && user.role !== "SUPER_ADMIN") return c.json({ error: "Shop not assigned" }, 403);

    const where: Record<string, unknown> = { deletedAt: null };
    if (user.role !== "SUPER_ADMIN") {
      // Non-super: only transfers involving their shop
      where.OR = [{ fromShopId: shopId }, { toShopId: shopId }];
    }
    if (statusQ && ["requested", "approved", "in_transit", "received", "rejected"].includes(statusQ)) {
      where.status = statusQ;
    }
    if (fromShopIdQ) where.fromShopId = fromShopIdQ;
    if (toShopIdQ) where.toShopId = toShopIdQ;

    const items = await prisma.stockTransfer.findMany({
      where,
      include: {
        fromShop: { select: { id: true, name: true, code: true } },
        toShop: { select: { id: true, name: true, code: true } },
        createdByUser: { select: { id: true, name: true, email: true } },
        approvedByUser: { select: { id: true, name: true, email: true } },
        items: {
          include: {
            product: { select: { id: true, name: true, barcode: true, unit: true } },
            batch: { select: { id: true, batchNo: true, expiryDate: true, mrp: true } },
          },
        },
      },
      orderBy: { createdAt: "desc" },
      take: limit,
    });

    return c.json({ transfers: items });
  } catch (e) {
    const { toAppError } = await import("../lib/errors.js");
    const appErr = toAppError(e);
    return c.json({ error: appErr.message, code: appErr.code }, appErr.status as 400 | 404 | 409 | 500 | 503);
  }
});

// POST /api/transfers — create a transfer request (shop owner or SUPER_ADMIN)
transfers.post("/", async (c) => {
  const user = (c as any).get("user") as any;
  const { shopId } = getShopScope(c);
  try {
    if (!shopId && user.role !== "SUPER_ADMIN") return c.json({ error: "Shop not assigned" }, 403);
    if (user.role === "SUPER_ADMIN" && !shopId) return c.json({ error: "shopId required for SUPER_ADMIN" }, 400);

    const body = await c.req.json();
    const { fromShopId, toShopId, items } = body as Record<string, unknown>;

    const fromShop = String(fromShopId ?? "");
    const toShop = String(toShopId ?? "");
    if (!fromShop || !toShop) return c.json({ error: "fromShopId and toShopId required" }, 400);
    if (fromShop === toShop) return c.json({ error: "fromShopId and toShopId must differ" }, 400);
    // Non-super can only create transfers from their own shop
    if (user.role !== "SUPER_ADMIN" && fromShop !== shopId) return c.json({ error: "Forbidden — can only transfer from your own shop" }, 403);

    if (!Array.isArray(items) || items.length === 0) return c.json({ error: "items[] required" }, 400);

    // Verify both shops exist and are active
    const [fromS, toS] = await Promise.all([
      prisma.shop.findUnique({ where: { id: fromShop } }),
      prisma.shop.findUnique({ where: { id: toShop } }),
    ]);
    if (!fromS || (fromS as any).deletedAt || !(fromS as any).isActive) return c.json({ error: "From shop not found or inactive" }, 404);
    if (!toS || (toS as any).deletedAt || !(toS as any).isActive) return c.json({ error: "To shop not found or inactive" }, 404);

    // Validate items and check source stock availability
    const preparedItems: Array<{ productId: string; batchId?: string | null; quantity: number; unitCost?: number | null }> = [];
    for (const it of items) {
      const pid = String(it.productId ?? "");
      const qty = Number(it.quantity);
      const bid = it.batchId ? String(it.batchId) : null;
      const unitCost = it.unitCost != null ? parseMoney(it.unitCost) : null;
      if (!pid || isNaN(qty) || qty <= 0) return c.json({ error: `Invalid item: productId and quantity required` }, 400);

      const product = await prisma.product.findUnique({ where: { id: pid } });
      if (!product || (product as any).deletedAt || (product as any).shopId !== fromShop) {
        return c.json({ error: `Product ${pid} not found in source shop` }, 404);
      }

      // If batch specified, verify it belongs to source shop and has stock
      if (bid) {
        const batch = await prisma.productBatch.findUnique({ where: { id: bid } });
        if (!batch || (batch as any).deletedAt || (batch as any).productId !== pid || (batch as any).shopId !== fromShop) {
          return c.json({ error: `Batch ${bid} not valid for product ${pid} in source shop` }, 404);
        }
        if (dec((batch as any).quantity) < qty) {
          return c.json({ error: `Insufficient stock in batch ${bid} for product ${pid}` }, 409);
        }
      }

      preparedItems.push({ productId: pid, batchId: bid, quantity: qty, unitCost });
    }

    const transfer = await prisma.$transaction(async (tx) => {
      const created = await tx.stockTransfer.create({
        data: {
          fromShopId: fromShop,
          toShopId: toShop,
          status: "requested",
          createdBy: user.userId,
        },
      });
      for (const it of preparedItems) {
        await tx.stockTransferItem.create({
          data: {
            transferId: created.id,
            productId: it.productId,
            batchId: it.batchId ?? undefined,
            quantity: it.quantity,
            unitCost: it.unitCost ?? undefined,
          },
        });
      }
      return created;
    });

    return c.json({ transfer }, 201);
  } catch (e) {
    const { toAppError } = await import("../lib/errors.js");
    const appErr = toAppError(e);
    return c.json({ error: appErr.message, code: appErr.code }, appErr.status as 400 | 404 | 409 | 500 | 503);
  }
});

// PATCH /api/transfers/:id/approve — SUPER_ADMIN or destination shop owner approves
transfers.patch("/:id/approve", async (c) => {
  const user = (c as any).get("user") as any;
  const { shopId } = getShopScope(c);
  const id = c.req.param("id");
  try {
    const existing = await prisma.stockTransfer.findUnique({ where: { id } });
    if (!existing || (existing as any).deletedAt) return c.json({ error: "Transfer not found" }, 404);
    if ((existing as any).status !== "requested") return c.json({ error: "Only requested transfers can be approved", code: "BAD_STATUS" }, 409);
    if (!(await transferAccessible(c, existing as any))) return c.json({ error: "Forbidden" }, 403);
    // Only SUPER_ADMIN or toShop owner can approve
    if (user.role !== "SUPER_ADMIN" && (existing as any).toShopId !== shopId) {
      return c.json({ error: "Forbidden — only destination shop or admin can approve" }, 403);
    }

    const transfer = await prisma.stockTransfer.update({
      where: { id },
      data: { status: "approved", approvedBy: user.userId },
    });
    return c.json({ transfer });
  } catch (e) {
    const { toAppError } = await import("../lib/errors.js");
    const appErr = toAppError(e);
    return c.json({ error: appErr.message, code: appErr.code }, appErr.status as 400 | 404 | 409 | 500 | 503);
  }
});

// PATCH /api/transfers/:id/reject — SUPER_ADMIN or either shop can reject
transfers.patch("/:id/reject", async (c) => {
  const user = (c as any).get("user") as any;
  const { shopId } = getShopScope(c);
  const id = c.req.param("id");
  try {
    const existing = await prisma.stockTransfer.findUnique({ where: { id } });
    if (!existing || (existing as any).deletedAt) return c.json({ error: "Transfer not found" }, 404);
    if ((existing as any).status !== "requested" && (existing as any).status !== "approved") {
      return c.json({ error: "Only requested or approved transfers can be rejected", code: "BAD_STATUS" }, 409);
    }
    if (!(await transferAccessible(c, existing as any))) return c.json({ error: "Forbidden" }, 403);

    const transfer = await prisma.stockTransfer.update({
      where: { id },
      data: { status: "rejected" },
    });
    return c.json({ transfer });
  } catch (e) {
    const { toAppError } = await import("../lib/errors.js");
    const appErr = toAppError(e);
    return c.json({ error: appErr.message, code: appErr.code }, appErr.status as 400 | 404 | 409 | 500 | 503);
  }
});

// PATCH /api/transfers/:id/receive — destination shop receives stock
transfers.patch("/:id/receive", async (c) => {
  const user = (c as any).get("user") as any;
  const { shopId } = getShopScope(c);
  const id = c.req.param("id");
  try {
    const existing = await prisma.stockTransfer.findUnique({ where: { id }, include: { items: true } });
    if (!existing || (existing as any).deletedAt) return c.json({ error: "Transfer not found" }, 404);
    if ((existing as any).status !== "approved" && (existing as any).status !== "in_transit") {
      return c.json({ error: "Only approved or in_transit transfers can be received", code: "BAD_STATUS" }, 409);
    }
    if (!(await transferAccessible(c, existing as any))) return c.json({ error: "Forbidden" }, 403);
    // Only toShop can receive
    if (user.role !== "SUPER_ADMIN" && (existing as any).toShopId !== shopId) {
      return c.json({ error: "Forbidden — only destination shop can receive" }, 403);
    }

    await prisma.$transaction(async (tx) => {
      // Decrement source batch quantities, increment destination product stock + batches
      for (const it of existing.items) {
        const qty = Number(it.quantity);
        if (qty <= 0) continue;

        // Source: decrement the batch that was allocated
        if (it.batchId) {
          await tx.productBatch.updateMany({
            where: { id: it.batchId, quantity: { gte: qty } },
            data: { quantity: { decrement: qty } },
          });
        } else {
          // No batch specified: decrement product-level stock at source (fallback)
          await tx.product.updateMany({
            where: { id: it.productId, stockQuantity: { gte: qty } },
            data: { stockQuantity: { decrement: qty } },
          });
        }

        // Destination: create or replenish a batch at the destination shop
        const product = await tx.product.findUnique({ where: { id: it.productId } });
        if (!product || (product as any).deletedAt) throw new Error(`Product ${it.productId} not found`);

        // Find existing active batch at destination with same batchNo, or create new
        let sourceBatch: any = null;
        if (it.batchId) {
          sourceBatch = await tx.productBatch.findUnique({ where: { id: it.batchId } });
        }
        const destBatch = await tx.productBatch.findFirst({
          where: {
            productId: it.productId,
            shopId: (existing as any).toShopId,
            deletedAt: null,
            ...(sourceBatch?.batchNo ? { batchNo: sourceBatch.batchNo } : {}),
          },
        });

        if (destBatch) {
          await tx.productBatch.update({
            where: { id: destBatch.id },
            data: { quantity: { increment: qty } },
          });
        } else {
          // Create a new batch at destination (inherits batchNo/expiry/mrp from source batch if available)
          await tx.productBatch.create({
            data: {
              productId: it.productId,
              shopId: (existing as any).toShopId,
              batchNo: sourceBatch?.batchNo ?? `TR-${id.slice(-6)}`,
              expiryDate: sourceBatch?.expiryDate ?? undefined,
              mrp: sourceBatch?.mrp ?? undefined,
              costPrice: it.unitCost ?? (sourceBatch?.costPrice ?? 0),
              quantity: qty,
              receivedAt: new Date(),
            },
          });
        }

        // Destination product-level stock increment
        await tx.product.update({
          where: { id: it.productId },
          data: { stockQuantity: { increment: qty } },
        });
      }

      await tx.stockTransfer.update({
        where: { id },
        data: { status: "received", completedAt: new Date() },
      });
    });

    const updated = await prisma.stockTransfer.findUnique({ where: { id } });
    return c.json({ transfer: updated });
  } catch (e) {
    const { toAppError } = await import("../lib/errors.js");
    const appErr = toAppError(e);
    return c.json({ error: appErr.message, code: appErr.code }, appErr.status as 400 | 404 | 409 | 500 | 503);
  }
});

// PATCH /api/transfers/:id/in_transit — mark as in transit (optional workflow step)
transfers.patch("/:id/in_transit", async (c) => {
  const user = (c as any).get("user") as any;
  const { shopId } = getShopScope(c);
  const id = c.req.param("id");
  try {
    const existing = await prisma.stockTransfer.findUnique({ where: { id } });
    if (!existing || (existing as any).deletedAt) return c.json({ error: "Transfer not found" }, 404);
    if ((existing as any).status !== "approved") return c.json({ error: "Only approved transfers can be marked in_transit", code: "BAD_STATUS" }, 409);
    if (!(await transferAccessible(c, existing as any))) return c.json({ error: "Forbidden" }, 403);

    const transfer = await prisma.stockTransfer.update({
      where: { id },
      data: { status: "in_transit" },
    });
    return c.json({ transfer });
  } catch (e) {
    const { toAppError } = await import("../lib/errors.js");
    const appErr = toAppError(e);
    return c.json({ error: appErr.message, code: appErr.code }, appErr.status as 400 | 404 | 409 | 500 | 503);
  }
});

export default transfers;
