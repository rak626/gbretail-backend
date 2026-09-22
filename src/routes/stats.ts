import { Hono } from "hono";
import { prisma } from "../lib/prisma.js";

const stats = new Hono();

stats.get("/", async (c) => {
  try {
    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);
    const todayEnd = new Date();
    todayEnd.setHours(23, 59, 59, 999);

    const [todayOrders, totalOrders, totalRevenueAgg, customersCount, lowStock] = await Promise.all([
      prisma.order.findMany({ where: { createdAt: { gte: todayStart, lte: todayEnd } }, select: { total: true, paymentMethod: true } }),
      prisma.order.count(),
      prisma.order.aggregate({ _sum: { total: true } }),
      prisma.customer.count(),
      prisma.product.findMany({ where: { stockQuantity: { lt: 10 } }, select: { id: true, name: true, stockQuantity: true }, take: 5 }),
    ]);

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
