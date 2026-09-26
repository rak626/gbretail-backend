import { Hono } from "hono";
import { prisma } from "../lib/prisma.js";
import { requireAuth } from "../middleware/auth.js";

const stats = new Hono();

stats.use("*", requireAuth as any);

stats.get("/", async (c) => {
  const user = (c as any).get("user" as any) as any;
  const shopId = ((c as any).get("shopId" as any) as string | null) || user?.shopId || c.req.query("shopId") || null;
  try {
    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);
    const todayEnd = new Date();
    todayEnd.setHours(23, 59, 59, 999);

    const shopFilter: Record<string, unknown> = shopId ? { shopId } : {};
    const accessError = !shopId && user.role !== "SUPER_ADMIN" ? true : false;
    if (accessError) return c.json({ error: "Shop not assigned" }, 403);

    const [todayOrders, totalOrders, totalRevenueAgg, customersCount, stockCandidates] = await Promise.all([
      prisma.order.findMany({ where: { createdAt: { gte: todayStart, lte: todayEnd }, deletedAt: null, ...shopFilter } as any, select: { total: true, paymentMethod: true } }),
      prisma.order.count({ where: { deletedAt: null, ...shopFilter } as any }),
      prisma.order.aggregate({ where: { deletedAt: null, ...shopFilter } as any, _sum: { total: true } }),
      prisma.customer.count({ where: { deletedAt: null, ...shopFilter } }),
      prisma.product.findMany({ where: { deletedAt: null, ...(shopId ? { shopId } : {}) } as any, select: { id: true, name: true, stockQuantity: true, lowStockThreshold: true, unit: true, shopId: true }, orderBy: { stockQuantity: "asc" }, take: 100 }),
    ]);

    // Per-product low-stock: warn when stockQuantity <= that product's own threshold
    const lowStock = (stockCandidates as Array<{ id: string; name: string; stockQuantity: number; lowStockThreshold: number | null; unit: string; shopId: string | null }>)
      .filter((p) => (p.stockQuantity ?? 0) <= (p.lowStockThreshold ?? 10))
      .slice(0, 5);

    const todayRevenue = todayOrders.reduce((s: number, o: { total: number }) => s + o.total, 0);
    const todayByPayment: Record<string, number> = {};
    for (const o of todayOrders) todayByPayment[o.paymentMethod] = (todayByPayment[o.paymentMethod] ?? 0) + o.total;

    return c.json({
      today: { orders: todayOrders.length, revenue: todayRevenue, byPayment: todayByPayment },
      total: { orders: totalOrders, revenue: totalRevenueAgg._sum.total ?? 0, customers: customersCount },
      lowStock,
    });
  } catch (e) {
    return c.json(
      {
        error: e instanceof Error ? e.message : "Failed",
        today: { orders: 0, revenue: 0, byPayment: {} },
        total: { orders: 0, revenue: 0, customers: 0 },
        lowStock: [],
      },
      500
    );
  }
});

export default stats;
