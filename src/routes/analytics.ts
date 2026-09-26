import { Hono } from "hono";
import { prisma } from "../lib/prisma.js";
import {
  getRangeBounds,
  getPrevRange,
  getBucketKey,
  formatBucketLabel,
  generateEmptyBuckets,
  grossProfitForItem,
  allocateDiscountToItems,
  getLedgerAgingBucket,
  LEDGER_AGING_BUCKETS,
} from "../lib/analytics.js";
import { requireAuth } from "../middleware/auth.js";
import { startOfDay } from "../lib/utils.js";

const analytics = new Hono();

analytics.use("*", requireAuth as any);

// Simple in-memory cache (30s)
const cache = new Map<string, { ts: number; data: any }>();
const CACHE_TTL = 30_000;
function cacheKey(c: any) {
  // Key on user+role+resolved shop as well as URL — summary/sections are role- and
  // shop-scoped, so a shared URL key would leak one shop/role's data to another.
  // SUPER_ADMIN switches shops via x-shop-id; include the header explicitly.
  const u = (c as any).get("user" as any) as any;
  const shopId = ((c as any).get("shopId" as any) as string | null) || u?.shopId || c.req.query("shopId") || c.req.header("x-shop-id") || c.req.header("X-Shop-Id") || "";
  const url = c.req.url;
  return `${u?.userId ?? "?"}:${u?.role ?? "?"}:${shopId}:${url}`;
}
function getCached(key: string) {
  const v = cache.get(key);
  if (v && Date.now() - v.ts < CACHE_TTL) return v.data;
  return null;
}
function setCached(key: string, data: any) {
  cache.set(key, { ts: Date.now(), data });
  if (cache.size > 100) {
    const first = cache.keys().next().value;
    if (first) cache.delete(first);
  }
}

// GET /api/analytics/summary?preset=7d&from&to&granularity&topN&category
analytics.get("/summary", async (c) => {
  const presetRaw = c.req.query("preset") ?? c.req.query("range") ?? "7d";
  const fromRaw = c.req.query("from");
  const toRaw = c.req.query("to");
  const granularityRaw = c.req.query("granularity");
  const topN = Math.min(Math.max(parseInt(c.req.query("topN") ?? "10", 10) || 10, 1), 50);
  const categoryFilter = (c.req.query("category") ?? "All").trim();

  const user = (c as any).get("user" as any) as any;
  const shopId = ((c as any).get("shopId" as any) as string | null) || user?.shopId || c.req.query("shopId") || null;
  if (!shopId && user.role !== "SUPER_ADMIN") return c.json({ error: "Shop not assigned" }, 403);
  const shopFilter: Record<string, unknown> = shopId ? { shopId } : {};

  const ck = cacheKey(c);
  const cached = getCached(ck);
  if (cached) return c.json(cached);

  try {
    const bounds = getRangeBounds(presetRaw, fromRaw, toRaw, granularityRaw);
    const { start, end, granularity, label } = bounds;
    // Cap range to 366 days — 5y at day granularity would OOM (full order+item load).
    // Longer ranges must use month granularity (already default for 1y+).
    const rangeDays = (end.getTime() - start.getTime()) / 86_400_000;
    if (rangeDays > 366) {
      return c.json({ error: "Range too large (max 366 days) — use a shorter preset or custom range", code: "RANGE_TOO_LARGE" }, 400);
    }
    const prev = getPrevRange(bounds);

    // Fetch orders in range + prev range for delta — scoped to shop
    // Include items
    const whereCurrent = { createdAt: { gte: start, lte: end }, deletedAt: null, ...shopFilter } as any;
    const wherePrev = { createdAt: { gte: prev.start, lte: prev.end }, deletedAt: null, ...shopFilter } as any;

    const [orders, prevOrders, ledgerCreated, ledgerSettled, ledgerPending] = await Promise.all([
      prisma.order.findMany({
        where: whereCurrent,
        include: { items: true },
        orderBy: { createdAt: "asc" },
      }),
      prisma.order.findMany({
        where: wherePrev,
        select: { total: true, discount: true, items: { select: { price: true, costPrice: true, quantity: true, weight: true, lineTotal: true } } },
      }),
      prisma.ledgerEntry.findMany({
        where: { createdAt: { gte: start, lte: end }, deletedAt: null, ...shopFilter } as any,
        select: { amount: true, createdAt: true, status: true, dueDate: true },
      }),
      prisma.ledgerEntry.findMany({
        where: { settledAt: { gte: start, lte: end }, status: "settled", deletedAt: null, ...shopFilter } as any,
        select: { amount: true, settledAt: true, createdAt: true },
      }),
      prisma.ledgerEntry.findMany({
        where: { status: "pending", deletedAt: null, ...shopFilter } as any,
        select: { amount: true, dueDate: true, createdAt: true, customerId: true },
      }),
    ]);

    // KPI computation
    let grossCurrent = 0;
    let netCurrent = 0;
    let discountCurrent = 0;
    let profitCurrentGross = 0; // before discount
    let profitCurrentNet = 0; // after discount
    let ordersCount = orders.length;

    // For category & top products aggregation
    const categoryMap = new Map<string, { gross: number; net: number; profit: number; qty: number }>();
    const productMap = new Map<string, { productId: string | null; name: string; category: string | null; qty: number; gross: number; profit: number }>();

    // Payment split (by method) + tender split (cash vs UPI inside split bills, for drawer tally)
    const paymentSplit: Record<string, number> = { cash: 0, upi: 0, khata: 0, split: 0 };
    let tenderSplitCash = 0;
    let tenderSplitUpi = 0;

    // Timeseries buckets
    const bucketKeys = generateEmptyBuckets(start, end, granularity);
    const tsMap = new Map<string, { orders: number; gross: number; netRevenue: number; profit: number; loss: number }>();
    for (const k of bucketKeys) tsMap.set(k, { orders: 0, gross: 0, netRevenue: 0, profit: 0, loss: 0 });

    for (const o of orders) {
      const gross = (o.items as any[]).reduce((s: number, it: any) => s + Number(it.lineTotal), 0);
      const discount = Number(o.discount ?? 0);
      const net = Number(o.total);
      // sanity: gross should be net+discount, but use actual lineTotal sum for gross
      grossCurrent += gross;
      discountCurrent += discount;
      netCurrent += net;

      // profit gross per order
      let orderProfitGross = 0;
      for (const it of o.items as any[]) {
        orderProfitGross += grossProfitForItem(it);
      }
      // discount allocation: allocate discount proportionally to items gross for net profit
      const discountAllocs = allocateDiscountToItems(o.items as any, discount, gross);
      let orderProfitNet = 0;
      (o.items as any[]).forEach((it: any, idx: number) => {
        const gp = grossProfitForItem(it);
        const alloc = discountAllocs[idx] ?? 0;
        const netProfitItem = gp - alloc;
        orderProfitNet += netProfitItem;

        // category aggregation (net)
        const cat = it.category ?? (it as any).product?.category ?? "Uncategorized";
        const entry = categoryMap.get(cat) ?? { gross: 0, net: 0, profit: 0, qty: 0 };
        const q = it.weight != null && it.weight > 0 ? Number(it.weight) : (it.quantity ? Number(it.quantity) : 1);
        entry.gross += Number(it.lineTotal);
        // net per category = gross - alloc
        entry.net += Number(it.lineTotal) - alloc;
        entry.profit += netProfitItem;
        entry.qty += q;
        categoryMap.set(cat, entry);

        // product aggregation
        const pid = it.productId ?? it.name;
        const pkey = `${pid}::${it.name}`;
        const pEntry = productMap.get(pkey) ?? { productId: it.productId ?? null, name: it.name, category: cat, qty: 0, gross: 0, profit: 0 };
        pEntry.qty += q;
        pEntry.gross += Number(it.lineTotal);
        pEntry.profit += netProfitItem;
        productMap.set(pkey, pEntry);
      });

      profitCurrentGross += orderProfitGross;
      profitCurrentNet += orderProfitNet;

      // payment split by net revenue
      const pm = (o.paymentMethod ?? "cash").toLowerCase();
      if (paymentSplit[pm] !== undefined) paymentSplit[pm] += net;
      else paymentSplit[pm] = net;
      // tender inside split bills: cash-in-drawer vs UPI-settled attribution
      if (pm === "split") {
        tenderSplitCash += Number((o as any).cashAmount ?? 0);
        tenderSplitUpi += Number((o as any).upiAmount ?? 0);
      }

      // timeseries bucket
      const bkey = getBucketKey(o.createdAt as Date, granularity);
      const ts = tsMap.get(bkey);
      if (ts) {
        ts.orders += 1;
        ts.gross += gross;
        ts.netRevenue += net;
        // profit per bucket: need to handle loss vs profit? We'll store net profit, but also split loss
        if (orderProfitNet >= 0) ts.profit += orderProfitNet;
        else ts.loss += Math.abs(orderProfitNet);
        // Also if we want profit bucket as netProfit (could be negative). We'll keep profit positive only, loss separate.
        // If net negative, profit bucket remains 0, loss bucket captures.
      } else {
        // if bucket not in map (hour granularity edge), create
        const nb = { orders: 1, gross, netRevenue: net, profit: orderProfitNet >=0 ? orderProfitNet : 0, loss: orderProfitNet <0 ? Math.abs(orderProfitNet):0 };
        tsMap.set(bkey, nb);
      }
    }

    // For buckets where we stored profit/loss split, we already handled. But for profitCurrentNet overall, split too:
    const profitKpi = profitCurrentNet >= 0 ? profitCurrentNet : 0;
    const lossKpi = profitCurrentNet < 0 ? Math.abs(profitCurrentNet) : 0;
    // However per category/product, we also split? Better to keep netProfit per category (could be negative). For top products, profit could be negative if loss product.
    // We'll keep as computed netProfit per product/category.

    // Prev period KPIs for delta
    let grossPrev = 0, netPrev = 0, profitPrevNet = 0, ordersPrev = prevOrders.length;
    for (const o of prevOrders) {
      const gross = (o.items as any[]).reduce((s: number, it: any) => s + Number(it.lineTotal), 0);
      const discount = Number(o.discount ?? 0);
      const net = Number(o.total);
      grossPrev += gross;
      netPrev += net;
      let orderProfitGross = 0;
      for (const it of o.items as any[]) orderProfitGross += grossProfitForItem(it);
      const allocs = allocateDiscountToItems(o.items as any, discount, gross);
      let orderProfitNet = 0;
      (o.items as any[]).forEach((it: any, idx: number) => {
        const gp = grossProfitForItem(it);
        orderProfitNet += gp - (allocs[idx] ?? 0);
      });
      profitPrevNet += orderProfitNet;
    }

    const delta = {
      orders: ordersPrev ? ((ordersCount - ordersPrev) / ordersPrev) * 100 : null,
      gross: grossPrev ? ((grossCurrent - grossPrev) / grossPrev) * 100 : null,
      netRevenue: netPrev ? ((netCurrent - netPrev) / netPrev) * 100 : null,
      profit: profitPrevNet ? ((profitCurrentNet - profitPrevNet) / Math.abs(profitPrevNet)) * 100 : null,
    };

    const avgOrderValue = ordersCount ? netCurrent / ordersCount : 0;
    const marginPct = netCurrent ? (profitCurrentNet / netCurrent) * 100 : 0;

    // Top products sorted by qty or gross? Default qty, but provide both. Sort by qty descending
    let topProducts = Array.from(productMap.values())
      .map(p => ({ ...p, qty: Number(p.qty.toFixed(3)), gross: Number(p.gross.toFixed(2)), profit: Number(p.profit.toFixed(2)), net: Number((p.gross - (p.profit ? 0 : 0)).toFixed(2)) }))
      // Actually p.gross is gross revenue per product, need to compute net per product after discount? Already profit is net, gross is gross.
      // For filtered category
    ;

    if (categoryFilter !== "All") {
      topProducts = topProducts.filter(p => p.category === categoryFilter);
    }
    topProducts.sort((a,b) => b.qty - a.qty);
    topProducts = topProducts.slice(0, topN);
    // Also provide sorted by revenue alternative: topByRevenue
    const topByRevenue = Array.from(productMap.values())
      .filter(p => categoryFilter === "All" || p.category === categoryFilter)
      .sort((a,b) => b.gross - a.gross)
      .slice(0, topN)
      .map(p => ({ ...p, qty: Number(p.qty.toFixed(3)), gross: Number(p.gross.toFixed(2)), profit: Number(p.profit.toFixed(2)) }));

    const categories = Array.from(categoryMap.entries())
      .map(([category, v]) => ({
        category,
        gross: Number(v.gross.toFixed(2)),
        netRevenue: Number(v.net.toFixed(2)),
        profit: Number(v.profit.toFixed(2)),
        qty: Number(v.qty.toFixed(3)),
        marginPct: v.net ? (v.profit / v.net) * 100 : 0,
      }))
      .sort((a,b) => b.netRevenue - a.netRevenue);

    // Timeseries array ordered by bucketKeys
    const timeseries = bucketKeys.map(k => {
      const v = tsMap.get(k) ?? { orders:0, gross:0, netRevenue:0, profit:0, loss:0 };
      return {
        bucket: k,
        label: formatBucketLabel(k, granularity),
        orders: v.orders,
        gross: Number(v.gross.toFixed(2)),
        netRevenue: Number(v.netRevenue.toFixed(2)),
        profit: Number(v.profit.toFixed(2)),
        loss: Number(v.loss.toFixed(2)),
        // netProfit = profit - loss if we split, but our ts stores profit positive, loss positive separately
        netProfit: Number((v.profit - v.loss).toFixed(2)),
      };
    });

    // Ledger analytics (paise-integer sums to avoid binary-float drift)
    const toPaise = (n: unknown) => Math.round(Number(n) * 100);
    const ledgerCreatedCount = ledgerCreated.length;
    const ledgerCreatedAmount = ledgerCreated.reduce((s, e) => s + toPaise(e.amount), 0) / 100;
    const ledgerSettledCount = ledgerSettled.length;
    const ledgerSettledAmount = ledgerSettled.reduce((s, e) => s + toPaise(e.amount), 0) / 100;
    const ledgerPendingCount = ledgerPending.length;
    const ledgerPendingAmount = ledgerPending.reduce((s, e) => s + toPaise(e.amount), 0) / 100;
    const ledgerOverdue = ledgerPending.filter(e => new Date(e.dueDate) < startOfDay(new Date()));
    const ledgerOverdueCount = ledgerOverdue.length;
    const ledgerOverdueAmount = ledgerOverdue.reduce((s,e)=>s+toPaise(e.amount),0) / 100;
    const collectionRate = (ledgerCreatedAmount + ledgerPendingAmount) ? (ledgerSettledAmount / (ledgerSettledAmount + ledgerPendingAmount) * 100) : 0;
    // avg days to settle from the already-fetched rows (createdAt selected above — no re-query).
    let avgDaysToSettle: number | null = null;
    if (ledgerSettled.length > 0) {
      const totalDays = (ledgerSettled as any[]).reduce((s, e) => {
        if (!e.settledAt || !e.createdAt) return s;
        return s + (new Date(e.settledAt as Date).getTime() - new Date(e.createdAt).getTime()) / 86_400_000;
      }, 0);
      avgDaysToSettle = totalDays / ledgerSettled.length;
    }

    // Aging buckets
    const agingMap = new Map<string, { count: number; amount: number }>();
    for (const b of LEDGER_AGING_BUCKETS) agingMap.set(b, { count:0, amount:0 });
    // also track Not due separately for ledgerPending but only overdue buckets for main ageing? We'll map pending to 0-7 etc including overdue only. For not due, we put in separate.
    const agingNotDue = new Map<string, { count:number; amount:number }>([["Not due (0-7d)", {count:0, amount:0}], ["Not due (8-15d)", {count:0, amount:0}], ["Not due (15+d)", {count:0, amount:0}]]);

    for (const e of ledgerPending) {
      const bucket = getLedgerAgingBucket(new Date(e.dueDate));
      if (agingMap.has(bucket)) {
        const cur = agingMap.get(bucket)!;
        cur.count += 1;
        cur.amount += Number(e.amount);
      } else if (agingNotDue.has(bucket)) {
        const cur = agingNotDue.get(bucket)!;
        cur.count += 1;
        cur.amount += Number(e.amount);
      }
    }
    const aging = Array.from(agingMap.entries()).map(([bucket, v]) => ({ bucket, count: v.count, amount: Number(v.amount.toFixed(2)) }));
    const agingNotDueArr = Array.from(agingNotDue.entries()).map(([bucket, v]) => ({ bucket, count: v.count, amount: Number(v.amount.toFixed(2)) }));

    // Ledger timeseries: created vs settled per bucket
    const ledgerTsMap = new Map<string, { created: number; settled: number; createdCount: number; settledCount: number }>();
    for (const k of bucketKeys) ledgerTsMap.set(k, { created:0, settled:0, createdCount:0, settledCount:0 });
    for (const e of ledgerCreated) {
      const k = getBucketKey(e.createdAt as Date, granularity);
      const v = ledgerTsMap.get(k);
      if (v) { v.created += Number(e.amount); v.createdCount +=1; }
    }
    for (const e of ledgerSettled) {
      const k = getBucketKey(e.settledAt as Date, granularity);
      const v = ledgerTsMap.get(k);
      if (v) { v.settled += Number(e.amount); v.settledCount +=1; }
    }
    const ledgerTimeseries = bucketKeys.map(k => {
      const v = ledgerTsMap.get(k) ?? { created:0, settled:0, createdCount:0, settledCount:0 };
      return { bucket: k, label: formatBucketLabel(k, granularity), created: Number(v.created.toFixed(2)), settled: Number(v.settled.toFixed(2)), createdCount: v.createdCount, settledCount: v.settledCount };
    });

    // Top category for kpi
    const topCategory = categories[0]?.category ?? null;

    const result = {
      range: { preset: bounds.preset, label: bounds.label, start: bounds.start.toISOString(), end: bounds.end.toISOString(), granularity },
      prevRange: { start: prev.start.toISOString(), end: prev.end.toISOString() },
      kpis: {
        orders: ordersCount,
        gross: Number(grossCurrent.toFixed(2)),
        discount: Number(discountCurrent.toFixed(2)),
        netRevenue: Number(netCurrent.toFixed(2)),
        profitGross: Number(profitCurrentGross.toFixed(2)),
        profit: Number(profitCurrentNet.toFixed(2)),
        profitPositive: Number(profitKpi.toFixed(2)),
        loss: Number(lossKpi.toFixed(2)),
        avgOrderValue: Number(avgOrderValue.toFixed(2)),
        marginPct: Number(marginPct.toFixed(2)),
        topCategory,
        delta,
        prev: { orders: ordersPrev, gross: Number(grossPrev.toFixed(2)), netRevenue: Number(netPrev.toFixed(2)), profit: Number(profitPrevNet.toFixed(2)) },
      },
      timeseries,
      topProducts,
      topByRevenue,
      categories,
      paymentSplit: {
        cash: Number((paymentSplit.cash ?? 0).toFixed(2)),
        upi: Number((paymentSplit.upi ?? 0).toFixed(2)),
        khata: Number((paymentSplit.khata ?? 0).toFixed(2)),
        split: Number((paymentSplit.split ?? 0).toFixed(2)),
      },
      tender: {
        splitCash: Number(tenderSplitCash.toFixed(2)),
        splitUpi: Number(tenderSplitUpi.toFixed(2)),
      },
      ledger: {
        created: { count: ledgerCreatedCount, amount: Number(ledgerCreatedAmount.toFixed(2)) },
        settled: { count: ledgerSettledCount, amount: Number(ledgerSettledAmount.toFixed(2)) },
        pending: { count: ledgerPendingCount, amount: Number(ledgerPendingAmount.toFixed(2)) },
        overdue: { count: ledgerOverdueCount, amount: Number(ledgerOverdueAmount.toFixed(2)) },
        collectionRate: Number(collectionRate.toFixed(2)),
        avgDaysToSettle: avgDaysToSettle != null ? Number(avgDaysToSettle.toFixed(2)) : null,
        aging,
        agingNotDue: agingNotDueArr,
        timeseries: ledgerTimeseries,
      },
      meta: { topN, categoryFilter, bucketCount: bucketKeys.length },
    };

    setCached(ck, result);
    return c.json(result);
  } catch (e) {
    return c.json({ error: e instanceof Error ? e.message : "Failed to fetch analytics", timeseries: [], topProducts: [], categories: [] }, 500);
  }
});

// GET /api/analytics/sections?preset&from&to(&shopId)
// Role-aware breakdowns for the 5 analytics tabs:
// - staff: SHOP_OWNER sees own-shop STAFF; SUPER_ADMIN sees SHOP_OWNERs (never staff)
// - customers: new / active / repeat+retention / top / defaulters (shop-scoped via orders)
// - shops: SUPER_ADMIN multi-shop compare; otherwise per-counter breakdown
analytics.get("/sections", async (c) => {
  const presetRaw = c.req.query("preset") ?? "7d";
  const fromRaw = c.req.query("from");
  const toRaw = c.req.query("to");

  const user = (c as any).get("user" as any) as any;
  const isSuper = user?.role === "SUPER_ADMIN";
  const queryShopId = c.req.query("shopId") || null;
  const scopeShopId = isSuper ? queryShopId : user?.shopId || null;
  if (!scopeShopId && !isSuper) return c.json({ error: "Shop not assigned" }, 403);
  const shopFilter: Record<string, unknown> = scopeShopId ? { shopId: scopeShopId } : {};

  const ck = cacheKey(c);
  const cached = getCached(ck);
  if (cached) return c.json(cached);

  try {
    const bounds = getRangeBounds(presetRaw, fromRaw, toRaw, undefined);
    const { start, end, label } = bounds;
    if ((end.getTime() - start.getTime()) / 86_400_000 > 366) {
      return c.json({ error: "Range too large (max 366 days)", code: "RANGE_TOO_LARGE" }, 400);
    }

    // Range orders (scoped) with staff/counter/customer attribution + item units
    const orders = await prisma.order.findMany({
      where: { createdAt: { gte: start, lte: end }, deletedAt: null, ...shopFilter } as any,
      select: {
        id: true, total: true, discount: true, userId: true, customerId: true,
        counterId: true, shopId: true, createdAt: true,
        items: { select: { quantity: true, weight: true } },
      },
      orderBy: { createdAt: "asc" },
    });
    const rangeRevenue = orders.reduce((s, o) => s + Number(o.total ?? 0), 0);

    // ---- Staff: owner sees staff, super sees owners ----
    const peopleRole = isSuper ? "SHOP_OWNER" : "STAFF";
    const people = await prisma.user.findMany({
      where: { role: peopleRole, deletedAt: null, ...(scopeShopId ? { shopId: scopeShopId } : { shopId: { not: null } }) } as any,
      select: { id: true, name: true, role: true, isActive: true, shopId: true, shop: { select: { id: true, name: true } } },
      orderBy: { name: "asc" },
    });
    const staff = (people as any[]).map((p) => {
      // Owner rows reflect their whole shop (super view); staff rows reflect personal billing
      const mine = p.role === "SHOP_OWNER"
        ? orders.filter((o) => (o as any).shopId && (o as any).shopId === p.shopId)
        : orders.filter((o) => (o as any).userId === p.id);
      const revenue = mine.reduce((s, o) => s + Number((o as any).total ?? 0), 0);
      const units = mine.reduce((s, o) => s + ((o as any).items ?? []).reduce((a: number, it: any) => a + (Number(it.quantity) || 0), 0), 0);
      const discount = mine.reduce((s, o) => s + Number((o as any).discount ?? 0), 0);
      return {
        id: p.id, name: p.name, role: p.role, isActive: p.isActive,
        shopId: p.shopId, shopName: (p as any).shop?.name ?? null,
        orders: mine.length,
        revenue: Number(revenue.toFixed(2)),
        avgBill: mine.length ? Number((revenue / mine.length).toFixed(2)) : 0,
        units,
        discount: Number(discount.toFixed(2)),
      };
    });

    // ---- Customers (per-shop: Customer.shopId) ----
    const idRows = await prisma.order.findMany({
      where: { deletedAt: null, createdAt: { lte: end }, ...shopFilter } as any,
      select: { customerId: true },
    });
    const scopedIds = Array.from(new Set(idRows.map((r) => r.customerId).filter(Boolean))) as string[];
    const scopedCustomers = await prisma.customer.findMany({
      where: { ...shopFilter, deletedAt: null, ...(scopedIds.length ? { id: { in: scopedIds } } : {}) },
      select: { id: true, name: true, phone: true, totalSpent: true, totalOrders: true, balance: true, firstOrderAt: true, createdAt: true, lastOrderAt: true },
    });
    // Per-shop spend from this shop's orders (authoritative for rankings);
    // Customer.balance/totalSpent are now per-shop too (one row per shop).
    const perShopAgg = await prisma.order.groupBy({
      by: ["customerId"],
      where: { deletedAt: null, customerId: { not: null }, ...shopFilter } as any,
      _sum: { total: true },
      _count: { _all: true },
    });
    const shopSpend = new Map<string, { spent: number; orders: number }>(
      perShopAgg.map((g) => [
        g.customerId as string,
        { spent: Number(Number((g._sum as any)?.total ?? 0).toFixed(2)), orders: (g._count as any)?._all ?? 0 },
      ])
    );
    const activeIds = Array.from(new Set(orders.map((o) => o.customerId).filter(Boolean))) as string[];
    const startMs = start.getTime();
    const endMs = end.getTime();
    const firstTs = (x: any) => {
      const d = x.firstOrderAt ?? x.createdAt;
      const t = d ? new Date(d).getTime() : NaN;
      return t;
    };
    const newCount = (scopedCustomers as any[]).filter((x) => {
      const t = firstTs(x);
      return !isNaN(t) && t >= startMs && t <= endMs;
    }).length;
    const activeCount = activeIds.length;
    const repeatCount = activeIds.filter((id) => (shopSpend.get(id)?.orders ?? 0) > 1).length;
    const retentionPct = activeCount ? Number(((repeatCount / activeCount) * 100).toFixed(1)) : 0;
    const avgCustomerValue = activeCount ? Number((rangeRevenue / activeCount).toFixed(2)) : 0;
    const top = [...(scopedCustomers as any[])]
      .sort((a, b) => Number(shopSpend.get(b.id)?.spent ?? 0) - Number(shopSpend.get(a.id)?.spent ?? 0))
      .slice(0, 10)
      .map((x) => ({ id: x.id, name: x.name, phone: x.phone, totalSpent: shopSpend.get(x.id)?.spent ?? 0, totalOrders: shopSpend.get(x.id)?.orders ?? 0, balance: Number(Number(x.balance ?? 0).toFixed(2)) }));
    const defaulters = [...(scopedCustomers as any[])]
      .filter((x) => Number(x.balance ?? 0) > 0)
      .sort((a, b) => Number(b.balance ?? 0) - Number(a.balance ?? 0))
      .slice(0, 8)
      .map((x) => ({ id: x.id, name: x.name, phone: x.phone, balance: Number(Number(x.balance ?? 0).toFixed(2)), totalOrders: shopSpend.get(x.id)?.orders ?? 0 }));

    // ---- Shops (super) or counters (shop-level) ----
    let shops: any[] | null = null;
    let counters: any[] | null = null;
    if (isSuper) {
      const shopList = await prisma.shop.findMany({
        where: { deletedAt: null, ...(scopeShopId ? { id: scopeShopId } : {}) },
        select: { id: true, name: true, isActive: true },
        orderBy: { name: "asc" },
      });
      const perShop = await Promise.all(
        (shopList as any[]).map(async (s) => {
          const so = await prisma.order.findMany({
            where: { shopId: s.id, createdAt: { gte: start, lte: end }, deletedAt: null },
            select: { total: true },
          });
          const revenue = so.reduce((a, o) => a + Number((o as any).total ?? 0), 0);
          return { id: s.id, name: s.name, isActive: (s as any).isActive, orders: so.length, revenue: Number(revenue.toFixed(2)), avgBill: so.length ? Number((revenue / so.length).toFixed(2)) : 0 };
        })
      );
      shops = perShop;
    } else if (scopeShopId) {
      const counterList = await prisma.counter.findMany({
        where: { shopId: scopeShopId, deletedAt: null },
        select: { id: true, name: true, isActive: true },
        orderBy: { name: "asc" },
      });
      counters = (counterList as any[]).map((ct) => {
        const mine = orders.filter((o) => (o as any).counterId === ct.id);
        const revenue = mine.reduce((s, o) => s + Number((o as any).total ?? 0), 0);
        return { id: ct.id, name: ct.name, isActive: ct.isActive, orders: mine.length, revenue: Number(revenue.toFixed(2)), avgBill: mine.length ? Number((revenue / mine.length).toFixed(2)) : 0 };
      });
    }

    const result = {
      range: { preset: bounds.preset, label, start: bounds.start.toISOString(), end: bounds.end.toISOString() },
      scope: { shopId: scopeShopId, role: user.role, staffRole: peopleRole },
      staff,
      customers: { newCount, activeCount, repeatCount, retentionPct, avgCustomerValue, top, defaulters },
      shops,
      counters,
    };
    setCached(ck, result);
    return c.json(result);
  } catch (e) {
    return c.json({ error: e instanceof Error ? e.message : "Failed to fetch breakdowns" }, 500);
  }
});

// GET /api/analytics/export?preset&format=csv
analytics.get("/export", async (c) => {
  const presetRaw = c.req.query("preset") ?? "7d";
  const fromRaw = c.req.query("from");
  const toRaw = c.req.query("to");
  const granularityRaw = c.req.query("granularity");
  const format = (c.req.query("format") ?? "csv").toLowerCase();
  const user = (c as any).get("user" as any) as any;
  const shopId = ((c as any).get("shopId" as any) as string | null) || user?.shopId || c.req.query("shopId") || null;
  if (!shopId && user.role !== "SUPER_ADMIN") return c.json({ error: "Shop not assigned" }, 403);
  const shopFilter: Record<string, unknown> = shopId ? { shopId } : {};

  try {
    const bounds = getRangeBounds(presetRaw, fromRaw, toRaw, granularityRaw);
    const { start, end, granularity } = bounds;
    if ((end.getTime() - start.getTime()) / 86_400_000 > 366) {
      return c.json({ error: "Range too large (max 366 days)", code: "RANGE_TOO_LARGE" }, 400);
    }

    // Reuse summary logic by internal fetch? Instead duplicate light query for export: timeseries + topProducts + categories
    // For export we need flat CSV: section timeseries, top products, categories, ledger aging
    // Fetch orders
    const orders = await prisma.order.findMany({
      where: { createdAt: { gte: start, lte: end }, deletedAt: null, ...shopFilter } as any,
      include: { items: true },
      orderBy: { createdAt: "asc" },
    });
    const ledgerPending = await prisma.ledgerEntry.findMany({
      where: { status: "pending", deletedAt: null, ...shopFilter } as any,
      select: { amount: true, dueDate: true },
    });

    // Compute same as summary but simplified for CSV
    const bucketKeys = generateEmptyBuckets(start, end, granularity);
    const tsMap = new Map<string, { orders: number; gross: number; net: number; profit: number }>();
    for (const k of bucketKeys) tsMap.set(k, { orders:0, gross:0, net:0, profit:0 });

    let gross = 0, net = 0, discount = 0, profitNet = 0, tenderCash = 0, tenderUpi = 0;
    const productMap = new Map<string, { name: string; category: string; qty:number; gross:number; profit:number }>();
    const catMap = new Map<string, { gross:number; net:number; profit:number; qty:number }>();

    for (const o of orders) {
      const ogross = (o.items as any[]).reduce((s, it)=>s+Number(it.lineTotal),0);
      const odiscount = Number(o.discount ?? 0);
      const onet = Number(o.total);
      gross += ogross; discount += odiscount; net += onet;
      if ((o.paymentMethod ?? "").toLowerCase() === "split") {
        tenderCash += Number((o as any).cashAmount ?? 0);
        tenderUpi += Number((o as any).upiAmount ?? 0);
      }
      const allocs = allocateDiscountToItems(o.items as any, odiscount, ogross);
      let orderProfit = 0;
      (o.items as any[]).forEach((it, idx)=>{
        const gp = grossProfitForItem(it);
        const np = gp - (allocs[idx]??0);
        orderProfit += np;
        const cat = it.category ?? "Uncategorized";
        const c = catMap.get(cat) ?? { gross:0, net:0, profit:0, qty:0 };
        const q = it.weight ? Number(it.weight) : (it.quantity? Number(it.quantity):1);
        c.gross += Number(it.lineTotal);
        c.net += Number(it.lineTotal) - (allocs[idx]??0);
        c.profit += np;
        c.qty += q;
        catMap.set(cat, c);
        const key = `${it.productId ?? it.name}::${it.name}`;
        const p = productMap.get(key) ?? { name: it.name, category: cat, qty:0, gross:0, profit:0 };
        p.qty += q;
        p.gross += Number(it.lineTotal);
        p.profit += np;
        productMap.set(key, p);
      });
      profitNet += orderProfit;
      const bkey = getBucketKey(o.createdAt as Date, granularity);
      const v = tsMap.get(bkey);
      if (v) { v.orders+=1; v.gross+=ogross; v.net+=onet; v.profit+=orderProfit; }
    }

    const timeseries = bucketKeys.map(k=>{
      const v = tsMap.get(k) ?? {orders:0,gross:0,net:0,profit:0};
      return { bucket:k, label:formatBucketLabel(k,granularity), orders:v.orders, gross:v.gross, net:v.net, profit:v.profit };
    });

    const topProducts = Array.from(productMap.values()).sort((a,b)=>b.qty-a.qty).slice(0,20);
    const categories = Array.from(catMap.entries()).map(([category, v])=>({category, ...v}));

    // Aging
    const agingMap = new Map<string, {count:number; amount:number}>();
    for (const b of LEDGER_AGING_BUCKETS) agingMap.set(b, {count:0, amount:0});
    for (const e of ledgerPending) {
      const b = getLedgerAgingBucket(new Date(e.dueDate));
      if (agingMap.has(b)) { const cur=agingMap.get(b)!; cur.count+=1; cur.amount+=Number(e.amount); }
    }

    if (format === "json") {
      return c.json({ range: { start: start.toISOString(), end: end.toISOString(), label: bounds.label, granularity }, kpis:{ orders: orders.length, gross, discount, net, profit: profitNet, tender: { splitCash: tenderCash, splitUpi: tenderUpi } }, timeseries, topProducts, categories, aging: Array.from(agingMap.entries()).map(([bucket, v])=>({bucket, ...v})) });
    }

    // CSV
    let csv = "";
    csv += `GB Retail Analytics Export - ${bounds.label} (${start.toISOString().slice(0,10)} to ${end.toISOString().slice(0,10)}) granularity:${granularity}\n`;
    csv += `Generated: ${new Date().toISOString()}\n\n`;
    csv += `KPIs\n`;
    csv += `Orders,Gross,Discount,Net Revenue,Profit Net,Margin %,Split Cash,Split UPI\n`;
    csv += `${orders.length},${gross.toFixed(2)},${discount.toFixed(2)},${net.toFixed(2)},${profitNet.toFixed(2)},${net? (profitNet/net*100).toFixed(2):0},${tenderCash.toFixed(2)},${tenderUpi.toFixed(2)}\n\n`;

    csv += `Timeseries (bucket,orders,gross,net,profit)\n`;
    csv += `Bucket,Label,Orders,Gross,Net Revenue,Profit\n`;
    for (const t of timeseries) {
      csv += `${t.bucket},${t.label},${t.orders},${t.gross.toFixed(2)},${t.net.toFixed(2)},${t.profit.toFixed(2)}\n`;
    }
    csv += `\nTop Products (qty)\n`;
    csv += `Name,Category,Qty,Gross,Profit\n`;
    for (const p of topProducts) {
      csv += `"${p.name.replace(/"/g,'""')}",${p.category},${p.qty},${p.gross.toFixed(2)},${p.profit.toFixed(2)}\n`;
    }
    csv += `\nCategories\n`;
    csv += `Category,Gross,Net,Profit,Qty\n`;
    for (const cat of categories) {
      csv += `${cat.category},${cat.gross.toFixed(2)},${cat.net.toFixed(2)},${cat.profit.toFixed(2)},${cat.qty}\n`;
    }
    csv += `\nLedger Aging (pending only)\n`;
    csv += `Bucket,Count,Amount\n`;
    for (const [bucket, v] of agingMap.entries()) {
      csv += `${bucket},${v.count},${v.amount.toFixed(2)}\n`;
    }

    c.header("Content-Type", "text/csv; charset=utf-8");
    c.header("Content-Disposition", `attachment; filename="analytics-${bounds.preset}-${new Date().toISOString().slice(0,10)}.csv"`);
    return c.text(csv);
  } catch (e) {
    return c.json({ error: e instanceof Error ? e.message : "Export failed" }, 500);
  }
});

export default analytics;
