import { Hono } from "hono";
import { prisma } from "../lib/prisma.js";
import { getShopScope } from "../lib/shopScope.js";
import { requireAuth } from "../middleware/auth.js";
import { dec, round2 } from "../lib/money.js";
import { startOfDay, endOfDay } from "../lib/utils.js";

const stats = new Hono();

stats.use("*", requireAuth as any);

stats.get("/", async (c) => {
  const user = (c as any).get("user" as any) as any;
  const { shopId } = getShopScope(c);
  try {
    const todayStart = startOfDay(new Date());
    const todayEnd = endOfDay(new Date());

    const shopFilter: Record<string, unknown> = shopId ? { shopId } : {};
    const accessError = !shopId && user.role !== "SUPER_ADMIN" ? true : false;
    if (accessError) return c.json({ error: "Shop not assigned" }, 403);

    const [todayOrders, totalOrders, totalRevenueAgg, customersCount, stockCandidates] = await Promise.all([
      prisma.order.findMany({ where: { createdAt: { gte: todayStart, lte: todayEnd }, deletedAt: null, ...shopFilter } as any, select: { total: true, paymentMethod: true, cashAmount: true, upiAmount: true } }),
      prisma.order.count({ where: { deletedAt: null, ...shopFilter } as any }),
      prisma.order.aggregate({ where: { deletedAt: null, ...shopFilter } as any, _sum: { total: true } }),
      prisma.customer.count({ where: { deletedAt: null, ...shopFilter } }),
      prisma.product.findMany({ where: { deletedAt: null, ...(shopId ? { shopId } : {}) } as any, select: { id: true, name: true, stockQuantity: true, lowStockThreshold: true, unit: true, shopId: true }, orderBy: { stockQuantity: "asc" }, take: 100 }),
    ]);

    // Per-product low-stock: warn when stockQuantity <= that product's own threshold
    const lowStock = (stockCandidates as Array<{ id: string; name: string; stockQuantity: unknown; lowStockThreshold: unknown; unit: string; shopId: string }>)
      .filter((p) => dec(p.stockQuantity) <= dec(p.lowStockThreshold ?? 10))
      .slice(0, 5);

    const todayRevenue = round2(todayOrders.reduce((s: number, o) => s + dec((o as any).total), 0));
    const todayByPayment: Record<string, number> = {};
    let todaySplitCash = 0;
    let todaySplitUpi = 0;
    for (const o of todayOrders) {
      todayByPayment[o.paymentMethod] = round2((todayByPayment[o.paymentMethod] ?? 0) + dec((o as any).total));
      if ((o.paymentMethod ?? "").toLowerCase() === "split") {
        todaySplitCash = round2(todaySplitCash + dec((o as any).cashAmount));
        todaySplitUpi = round2(todaySplitUpi + dec((o as any).upiAmount));
      }
    }

    return c.json({
      today: { orders: todayOrders.length, revenue: todayRevenue, byPayment: todayByPayment, tender: { splitCash: todaySplitCash, splitUpi: todaySplitUpi } },
      total: { orders: totalOrders, revenue: dec(totalRevenueAgg._sum.total) ?? 0, customers: customersCount },
      lowStock,
    });
  } catch (e) {
    const { toAppError: toAppErrStats } = await import("../lib/errors.js");
    const appErr = toAppErrStats(e);
    return c.json(
      {
        error: appErr.message,
        code: appErr.code,
        today: { orders: 0, revenue: 0, byPayment: {} },
        total: { orders: 0, revenue: 0, customers: 0 },
        lowStock: [],
      },
      500
    );
  }
});

export default stats;
