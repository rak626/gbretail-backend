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

const analytics = new Hono();

// Simple in-memory cache (30s)
const cache = new Map<string, { ts: number; data: any }>();
const CACHE_TTL = 30_000;
function cacheKey(c: any) {
  const url = c.req.url;
  return url;
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

  const ck = cacheKey(c);
  const cached = getCached(ck);
  if (cached) return c.json(cached);

  try {
    const bounds = getRangeBounds(presetRaw, fromRaw, toRaw, granularityRaw);
    const { start, end, granularity, label } = bounds;
    const prev = getPrevRange(bounds);

    // Fetch orders in range + prev range for delta
    // Include items
    const whereCurrent = { createdAt: { gte: start, lte: end } } as any;
    const wherePrev = { createdAt: { gte: prev.start, lte: prev.end } } as any;

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
        where: { createdAt: { gte: start, lte: end } },
        select: { amount: true, createdAt: true, status: true, dueDate: true },
      }),
      prisma.ledgerEntry.findMany({
        where: { settledAt: { gte: start, lte: end }, status: "settled" },
        select: { amount: true, settledAt: true },
      }),
      prisma.ledgerEntry.findMany({
        where: { status: "pending" },
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

    // Payment split
    const paymentSplit: Record<string, number> = { cash: 0, upi: 0, khata: 0, split: 0 };

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

    // Ledger analytics
    const ledgerCreatedCount = ledgerCreated.length;
    const ledgerCreatedAmount = ledgerCreated.reduce((s, e) => s + Number(e.amount), 0);
    const ledgerSettledCount = ledgerSettled.length;
    const ledgerSettledAmount = ledgerSettled.reduce((s, e) => s + Number(e.amount), 0);
    const ledgerPendingCount = ledgerPending.length;
    const ledgerPendingAmount = ledgerPending.reduce((s, e) => s + Number(e.amount), 0);
    const ledgerOverdue = ledgerPending.filter(e => new Date(e.dueDate) < new Date(new Date().setHours(0,0,0,0)));
    const ledgerOverdueCount = ledgerOverdue.length;
    const ledgerOverdueAmount = ledgerOverdue.reduce((s,e)=>s+Number(e.amount),0);
    const collectionRate = (ledgerCreatedAmount + ledgerPendingAmount) ? (ledgerSettledAmount / (ledgerSettledAmount + ledgerPendingAmount) * 100) : 0;
    // avg days to settle: for settled entries in range, avg(settledAt - createdAt)
    // Need to fetch settled entries with createdAt to compute avg; we only have settledAt, need createdAt too. Refetch? Use ledgerSettled already filtered by settledAt range, but we didn't select createdAt. Let's approximate without.
    // For quick, compute avg days for those settled entries we have if we had createdAt. Since we selected only amount/settledAt, fallback to 0.
    // Instead fetch more: we already have ledgerSettled without createdAt; compute 0.
    let avgDaysToSettle: number | null = null;
    if (ledgerSettled.length > 0) {
      // Re-query with createdAt for accurate
      const withCreated = await prisma.ledgerEntry.findMany({
        where: { settledAt: { gte: start, lte: end }, status: "settled" },
        select: { createdAt: true, settledAt: true },
      });
      if (withCreated.length) {
        const totalDays = withCreated.reduce((s, e) => {
          const diff = (new Date(e.settledAt as Date).getTime() - new Date(e.createdAt).getTime()) / (1000*60*60*24);
          return s + diff;
        }, 0);
        avgDaysToSettle = totalDays / withCreated.length;
      }
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

// GET /api/analytics/export?preset&format=csv
analytics.get("/export", async (c) => {
  const presetRaw = c.req.query("preset") ?? "7d";
  const fromRaw = c.req.query("from");
  const toRaw = c.req.query("to");
  const granularityRaw = c.req.query("granularity");
  const format = (c.req.query("format") ?? "csv").toLowerCase();

  try {
    const bounds = getRangeBounds(presetRaw, fromRaw, toRaw, granularityRaw);
    const { start, end, granularity } = bounds;

    // Reuse summary logic by internal fetch? Instead duplicate light query for export: timeseries + topProducts + categories
    // For export we need flat CSV: section timeseries, top products, categories, ledger aging
    // Fetch orders
    const orders = await prisma.order.findMany({
      where: { createdAt: { gte: start, lte: end } },
      include: { items: true },
      orderBy: { createdAt: "asc" },
    });
    const ledgerPending = await prisma.ledgerEntry.findMany({
      where: { status: "pending" },
      select: { amount: true, dueDate: true },
    });

    // Compute same as summary but simplified for CSV
    const bucketKeys = generateEmptyBuckets(start, end, granularity);
    const tsMap = new Map<string, { orders: number; gross: number; net: number; profit: number }>();
    for (const k of bucketKeys) tsMap.set(k, { orders:0, gross:0, net:0, profit:0 });

    let gross = 0, net = 0, discount = 0, profitNet = 0;
    const productMap = new Map<string, { name: string; category: string; qty:number; gross:number; profit:number }>();
    const catMap = new Map<string, { gross:number; net:number; profit:number; qty:number }>();

    for (const o of orders) {
      const ogross = (o.items as any[]).reduce((s, it)=>s+Number(it.lineTotal),0);
      const odiscount = Number(o.discount ?? 0);
      const onet = Number(o.total);
      gross += ogross; discount += odiscount; net += onet;
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
      return c.json({ range: { start: start.toISOString(), end: end.toISOString(), label: bounds.label, granularity }, kpis:{ orders: orders.length, gross, discount, net, profit: profitNet }, timeseries, topProducts, categories, aging: Array.from(agingMap.entries()).map(([bucket, v])=>({bucket, ...v})) });
    }

    // CSV
    let csv = "";
    csv += `GB Retail Analytics Export - ${bounds.label} (${start.toISOString().slice(0,10)} to ${end.toISOString().slice(0,10)}) granularity:${granularity}\n`;
    csv += `Generated: ${new Date().toISOString()}\n\n`;
    csv += `KPIs\n`;
    csv += `Orders,Gross,Discount,Net Revenue,Profit Net,Margin %\n`;
    csv += `${orders.length},${gross.toFixed(2)},${discount.toFixed(2)},${net.toFixed(2)},${profitNet.toFixed(2)},${net? (profitNet/net*100).toFixed(2):0}\n\n`;

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
