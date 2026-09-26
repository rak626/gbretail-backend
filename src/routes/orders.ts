import { Hono } from "hono";
import { prisma } from "../lib/prisma.js";
import { computeDueDate, generateOrderNumber, startOfDay, endOfDay } from "../lib/utils.js";
import { normalizePhone } from "../lib/normalize.js";
import { toAppError, AppError } from "../lib/errors.js";
import { requireAuth } from "../middleware/auth.js";
import { getShopScope } from "../lib/shopScope.js";
import { resolveStaffCounter } from "../lib/staffCounter.js";
import { round2, parseMoney, dec, MAX_MONEY } from "../lib/money.js";
import { getIdempotencyKey, isValidIdempotencyKey, fingerprint } from "../lib/idempotency.js";

const orders = new Hono();

orders.use("*", requireAuth as any);

// Per-shop sequential bill numbers via ShopOrderSeq (atomic increment, no races).
// Format: ORD-YYYYMMDD-<SHOP4>-<NNNN> e.g. ORD-20250115-EF12-0042.
// Monotonic per shop (not per day) — globally unique via shop suffix + seq.
function istDateParts(d = new Date()): { yyyy: string; mm: string; dd: string } {
  const fmt = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata", year: "numeric", month: "2-digit", day: "2-digit" });
  const parts = fmt.formatToParts(d);
  const map: Record<string, string> = {};
  for (const p of parts) map[p.type] = p.value;
  return { yyyy: map.year, mm: map.month, dd: map.day };
}
async function getNextShopOrderNumber(tx: any, shopId: string | null) {
  if (!shopId) return generateOrderNumber();
  const row = await tx.shopOrderSeq.upsert({
    where: { shopId },
    update: { lastNo: { increment: 1 } },
    create: { shopId, lastNo: 1 },
  });
  const seqNo = (row as any).lastNo as number;
  const { yyyy, mm, dd } = istDateParts();
  const shopShort = shopId.slice(-4).toUpperCase().padStart(4, "0");
  const seq = String(seqNo).padStart(4, "0");
  return `ORD-${yyyy}${mm}${dd}-${shopShort}-${seq}`;
}

// GET /api/orders/next-number (must be before /:id)
// Preview only — reads ShopOrderSeq without incrementing; POST / is authoritative.
// Do not use for idempotency; POST / returns the authoritative number.
orders.get("/next-number", async (c) => {
  const { user, shopId } = getShopScope(c);
  try {
    if (!shopId && user.role !== "SUPER_ADMIN") return c.json({ error: "Shop not assigned" }, 403);
    if (!shopId) return c.json({ error: "shopId required for preview" }, 400);
    const seqRow = await prisma.shopOrderSeq.findUnique({ where: { shopId } });
    const nextNo = ((seqRow as any)?.lastNo ?? 0) + 1;
    const { yyyy, mm, dd } = istDateParts();
    const shopShort = shopId.slice(-4).toUpperCase().padStart(4, "0");
    const seq = String(nextNo).padStart(4, "0");
    return c.json({ orderNumber: `ORD-${yyyy}${mm}${dd}-${shopShort}-${seq}`, preview: true, count: nextNo });
  } catch {
    const d = new Date();
    const yyyy = d.getFullYear();
    const mm = String(d.getMonth() + 1).padStart(2, "0");
    const dd = String(d.getDate()).padStart(2, "0");
    const rnd = Math.random().toString(36).substring(2, 6).toUpperCase();
    return c.json({ orderNumber: `ORD-${yyyy}${mm}${dd}-${rnd}`, count: 0, fallback: true });
  }
});

// GET /api/orders?page&limit&customerId&paymentMethod&search&customer&date&from&to
// search = order number (kept backward-compat), customer = customer name/phone,
// date = single day (legacy), from/to = YYYY-MM-DD range (preferred)
// Pagination: legacy ?page&limit (deprecated) OR cursor ?cursor&limit → { nextCursor }.
orders.get("/", async (c) => {
  const { parseLimit, decodeCursor, encodeCursor, cursorWhere } = await import("../lib/pagination.js");
  const limit = parseLimit(c.req.query("limit") ?? "50", 50, 100);
  const rawPage = parseInt(c.req.query("page") ?? "1", 10);
  const page = isNaN(rawPage) ? 1 : Math.max(rawPage, 1);
  const cursorParam = c.req.query("cursor") ?? null;
  const customerId = c.req.query("customerId");
  const paymentMethod = (c.req.query("paymentMethod") ?? "").trim();
  const search = (c.req.query("search") ?? "").trim();
  const customerQ = (c.req.query("customer") ?? "").trim();
  const date = c.req.query("date");
  const from = (c.req.query("from") ?? "").trim();
  const to = (c.req.query("to") ?? "").trim();
  const { user, shopId } = getShopScope(c);

  try {
    const where: Record<string, unknown> = { deletedAt: null };
    if (shopId) (where as any).shopId = shopId;
    else if (user.role !== "SUPER_ADMIN") return c.json({ error: "Shop not assigned" }, 403);
    // super admin without shopId can see all, but filter by query shopId if provided
    if (customerId) where.customerId = customerId;
    if (paymentMethod && ["cash", "upi", "khata", "split"].includes(paymentMethod.toLowerCase())) {
      where.paymentMethod = paymentMethod.toLowerCase();
    }
    if (search) where.orderNumber = { contains: search, mode: "insensitive" as const };
    if (customerQ) {
      (where as any).customer = {
        OR: [
          { name: { contains: customerQ, mode: "insensitive" as const } },
          { phone: { contains: customerQ } },
        ],
      };
    }
    if (from || to) {
      const rawStart = from ? new Date(from) : new Date(to as string);
      const rawEnd = to ? new Date(to) : new Date(from as string);
      const start = startOfDay(rawStart);
      const end = endOfDay(rawEnd);
      if (!isNaN(start.getTime()) && !isNaN(end.getTime()) && start <= end) {
        where.createdAt = { gte: start, lte: end };
      }
    } else if (date) {
      const start = startOfDay(new Date(date));
      const end = endOfDay(new Date(date));
      if (!isNaN(start.getTime()) && !isNaN(end.getTime())) {
        where.createdAt = { gte: start, lte: end };
      }
    }
    // optional counter filter
    const counterIdQ = c.req.query("counterId");
    if (counterIdQ) (where as any).counterId = counterIdQ;

    if (cursorParam) {
      const decoded = decodeCursor(cursorParam);
      if (!decoded) return c.json({ error: "Invalid cursor", code: "INVALID_CURSOR" }, 400);
      const cw = cursorWhere(decoded);
      const cursorWhereClause = { AND: [where, cw] };
      const rows = await prisma.order.findMany({
        where: cursorWhereClause as any,
        include: { items: true, customer: { select: { id: true, name: true, phone: true } }, shop: { select: { id: true, name: true } }, counter: { select: { id: true, name: true } }, user: { select: { id: true, name: true, email: true } } },
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        take: limit + 1,
      });
      const hasMore = rows.length > limit;
      const items = hasMore ? rows.slice(0, limit) : rows;
      const last = items[items.length - 1] as any;
      const nextCursor = hasMore && last ? encodeCursor(last.createdAt, last.id) : null;
      return c.json({ orders: items, nextCursor, limit });
    }

    const [items, total] = await Promise.all([
      prisma.order.findMany({
        where: where as any,
        include: { items: true, customer: { select: { id: true, name: true, phone: true } }, shop: { select: { id: true, name: true } }, counter: { select: { id: true, name: true } }, user: { select: { id: true, name: true, email: true } } },
        orderBy: { createdAt: "desc" },
        take: limit,
        skip: (page - 1) * limit,
      }),
      prisma.order.count({ where: where as any }),
    ]);

    return c.json({ orders: items, total, page, limit });
  } catch (e) {
    const appErr = toAppError(e);
    return c.json({ error: appErr.message, code: appErr.code, orders: [], total: 0 }, 500);
  }
});

// GET /api/orders/:id  (id or orderNumber)
orders.get("/:id", async (c) => {
  const id = c.req.param("id");
  const { user, shopId } = getShopScope(c);
  try {
    const order = await prisma.order.findFirst({
      where: { OR: [{ id }, { orderNumber: id }] },
      include: { items: true, customer: true, shop: { select: { id: true, name: true } }, counter: { select: { id: true, name: true } }, user: { select: { id: true, name: true } } },
    });
    if (!order || (order as any).deletedAt) return c.json({ error: "Order not found" }, 404);
    if (shopId && (order as any).shopId && (order as any).shopId !== shopId && user.role !== "SUPER_ADMIN") {
      return c.json({ error: "Forbidden — order belongs to another shop" }, 403);
    }
    return c.json({ order });
  } catch (e) {
    const appErr = toAppError(e);
    return c.json({ error: appErr.message, code: appErr.code }, 500);
  }
});

// POST /api/orders
orders.post("/", async (c) => {
  // Hoisted for the P2002 race fallback in catch (block-scoped consts inside try are invisible there)
  let idemKey: string | null = null;
  let orderFingerprint: string | null = null;
  let findIdempotentOrder: (() => Promise<unknown>) | null = null;
  try {
    const body = await c.req.json();
    const user = (c as any).get("user") as any;
    // Pinned to JWT shop for OWNER/STAFF; SUPER_ADMIN may pass body.shopId/?shopId.
    const { shopId: ctxShop } = getShopScope(c);
    const { superShopOverride } = await import("../lib/shopScope.js");
    let shopId: string | null = ctxShop ?? user?.shopId ?? null;
    if (user.role === "SUPER_ADMIN") {
      shopId = superShopOverride(c, body as Record<string, unknown>) ?? shopId;
    }
    if (user.role !== "SUPER_ADMIN" && !shopId) return c.json({ error: "Shop not assigned" }, 403);
    if (user.role === "SUPER_ADMIN" && !shopId) return c.json({ error: "shopId required for SUPER_ADMIN" }, 400);

    // Validate shop exists
    const shop = await prisma.shop.findUnique({ where: { id: shopId! } });
    if (!shop || (shop as any).deletedAt || !(shop as any).isActive) return c.json({ error: "Shop not found or inactive" }, 404);

    let { items, total, discount = 0, paymentMethod, customerId, customerName, customerPhone, status = "completed", creditDays, customDays, counterId, splitCash, splitUpi, overrideLimit } = body;

    if (!Array.isArray(items) || items.length === 0) {
      return c.json({ error: "Items required" }, 400);
    }
    if (!paymentMethod || !["cash", "upi", "khata", "split"].includes(paymentMethod)) {
      return c.json({ error: "Invalid paymentMethod" }, 400);
    }
    // Split-tender breakdown: required for split, forbidden otherwise (single-method
    // semantics stay strict — cash/upi/khata rows keep NULL tender columns).
    const tenderSent = splitCash != null || splitUpi != null;
    if (paymentMethod !== "split" && tenderSent) {
      return c.json({ error: "splitCash/splitUpi only allowed with paymentMethod 'split'" }, 400);
    }

    // Counter validation: STAFF always bill on their assigned counter
    // (client value ignored — prevents forged counter attribution).
    // Owner/super: must belong to shop if provided, else first active counter.
    if (user.role === "STAFF") {
      if (!shopId) return c.json({ error: "Shop not assigned" }, 403);
      const sc = await resolveStaffCounter(user.userId, shopId);
      if (!sc) return c.json({ error: "No counter assigned — contact owner" }, 403);
      counterId = sc.id;
    } else if (counterId) {
      const counter = await prisma.counter.findUnique({ where: { id: String(counterId) } });
      if (!counter || (counter as any).deletedAt || !(counter as any).isActive) return c.json({ error: "Counter not found or inactive" }, 404);
      if ((counter as any).shopId !== shopId) return c.json({ error: "Counter does not belong to shop" }, 403);
    } else {
      // auto pick first active counter of shop if not provided
      const firstCounter = await prisma.counter.findFirst({ where: { shopId: shopId!, deletedAt: null, isActive: true } });
      if (firstCounter) counterId = firstCounter.id;
    }

    // RECALCULATE totals server-side — never trust client total.
    // Each line rounded to 2dp, then the bill rounded. costPrice is NOT trusted here
    // (resolved from DB inside the tx); the loop below only validates money shape.
    let gross = 0;
    for (const it of items as Record<string, unknown>[]) {
      const lt = parseMoney((it as any).lineTotal);
      const price = parseMoney((it as any).price);
      if (isNaN(lt) || lt < 0 || lt > MAX_MONEY) return c.json({ error: `Invalid lineTotal for ${(it as any).name}` }, 400);
      if (isNaN(price) || price < 0 || price > MAX_MONEY) return c.json({ error: `Invalid price for ${(it as any).name}` }, 400);
      const q = Number((it as any).quantity ?? (it as any).weight ?? 1);
      if (isNaN(q) || q <= 0) return c.json({ error: `Invalid quantity/weight for ${(it as any).name}` }, 400);
      // lineTotal must match price × qty to the paise (integer-paise compare so
      // binary-float dust like 0.010000000000000009 never causes false rejects)
      const expected = round2(price * q);
      if (Math.round(lt * 100) !== Math.round(expected * 100)) return c.json({ error: `lineTotal mismatch for ${(it as any).name}: expected ${expected.toFixed(2)}` }, 400);
      (it as any).lineTotal = lt;
      (it as any).price = price;
      gross = round2(gross + lt);
    }
    gross = round2(gross);
    discount = parseMoney(discount);
    if (isNaN(discount) || discount < 0 || discount > MAX_MONEY) return c.json({ error: "Discount must be >=0" }, 400);
    if (discount > gross) return c.json({ error: `Discount (${discount}) cannot exceed gross (${gross})` }, 400);
    const netTotal = round2(gross - discount);
    // Use netTotal as the order total (after discount)
    total = netTotal;

    // Split tender must cover the bill exactly, to the paise.
    let tenderCash: number | null = null;
    let tenderUpi: number | null = null;
    if (paymentMethod === "split") {
      tenderCash = parseMoney(splitCash);
      tenderUpi = parseMoney(splitUpi);
      if (isNaN(tenderCash) || tenderCash <= 0 || tenderCash > MAX_MONEY) return c.json({ error: "splitCash required (>0, max 2 decimals)" }, 400);
      if (isNaN(tenderUpi) || tenderUpi <= 0 || tenderUpi > MAX_MONEY) return c.json({ error: "splitUpi required (>0, max 2 decimals)" }, 400);
      if (Math.round(round2(tenderCash + tenderUpi) * 100) !== Math.round(netTotal * 100)) {
        return c.json({ error: `splitCash + splitUpi must equal total ${netTotal.toFixed(2)}` }, 400);
      }
    }

    // Idempotency: same key + same bill -> return original; same key + different bill -> 422.
    idemKey = getIdempotencyKey(c, body as Record<string, unknown>);
    if (idemKey && !isValidIdempotencyKey(idemKey)) {
      return c.json({ error: "Invalid Idempotency-Key (8-128 chars: A-Z a-z 0-9 _ -)", code: "INVALID_IDEMPOTENCY_KEY" }, 400);
    }
    orderFingerprint = idemKey
      ? fingerprint({
          total: netTotal,
          discount,
          paymentMethod,
          splitCash: tenderCash,
          splitUpi: tenderUpi,
          items: (items as Record<string, unknown>[]).map((it) => ({
            productId: (it.productId as string) || null,
            name: String(it.name),
            price: (it as any).price,
            qty: Number((it as any).quantity ?? (it as any).weight ?? 1),
            lineTotal: (it as any).lineTotal,
          })),
          customer: customerId ? String(customerId) : `${normalizePhone(customerPhone) || ""}|${customerName ? String(customerName).trim() : ""}`,
          counterId: counterId ? String(counterId) : null,
        })
      : null;
    findIdempotentOrder = async () => {
      if (!idemKey) return null;
      return prisma.order.findFirst({
        where: { shopId: shopId!, idempotencyKey: idemKey },
        include: { items: true, customer: true },
      });
    };
    if (idemKey) {
      const dup = (await findIdempotentOrder()) as any;
      if (dup) {
        if ((dup as any).deletedAt) return c.json({ error: "Duplicate — this bill was already voided", code: "IDEMPOTENT_REPLAY_VOIDED", orderNumber: (dup as any).orderNumber }, 409);
        if ((dup as any).idempotencyFingerprint && (dup as any).idempotencyFingerprint !== orderFingerprint) {
          return c.json({ error: "Idempotency-Key already used for a different bill", code: "IDEMPOTENCY_KEY_REUSED" }, 422);
        }
        return c.json({ order: dup, lowStockWarnings: [], idempotentReplay: true });
      }
    }

    // Use transaction to ensure atomicity: customer updates + order + ledger + stock
    // lowStockWarnings is informational only — sales are never blocked (warn-only)
    // count+1 order numbers are racy — retry the whole tx on orderNumber P2002.
    const lowStockWarnings: Array<{ productId: string; name: string; stockQuantity: number; lowStockThreshold: number; unit: string }> = [];
    let order: unknown = null;
    let orderNumberConflict: unknown = null;
    for (let attempt = 0; attempt < 3; attempt++) {
      lowStockWarnings.length = 0;
      orderNumberConflict = null;
      try {
        order = await prisma.$transaction(async (tx) => {
      // Order number per shop with retry on conflict
      let orderNumber: string;
      try {
        orderNumber = await getNextShopOrderNumber(tx as any, shopId);
      } catch {
        orderNumber = generateOrderNumber();
      }

      let resolvedCustomerId: string | null = customerId ? String(customerId) : null;
      const now = new Date();

      if (!resolvedCustomerId && (customerName || customerPhone) && paymentMethod === "khata") {
        const phone = normalizePhone(customerPhone);
        const name = customerName ? String(customerName).trim() : "Walk-in Customer";
        if (phone) {
          const existing = await tx.customer.findFirst({ where: { shopId: shopId!, phone } });
          if (existing) {
            // Credit-limit enforcement (owner/super may override explicitly)
            const canOverride = overrideLimit === true && (user.role === "SHOP_OWNER" || user.role === "SUPER_ADMIN");
            if (!canOverride && (existing as any).creditLimit != null) {
              const bal = dec((existing as any).balance);
              const lim = dec((existing as any).creditLimit);
              if (bal + Number(total) > lim) {
                throw new AppError(422, `Credit limit exceeded (balance ${bal.toFixed(2)} + bill ${Number(total).toFixed(2)} > limit ${lim.toFixed(2)})`, "CREDIT_LIMIT_EXCEEDED");
              }
            }
            resolvedCustomerId = existing.id;
            const isFirst = !(existing as { firstOrderAt?: Date | null }).firstOrderAt;
            await tx.customer.update({
              where: { id: existing.id },
              data: {
                balance: { increment: total },
                totalSpent: { increment: total },
                totalOrders: { increment: 1 },
                lastOrderAt: now,
                ...(isFirst ? { firstOrderAt: now } : {}),
                ...((existing as { deletedAt?: Date | null }).deletedAt ? { deletedAt: null } : {}),
              },
            });
          } else {
            const cust = await tx.customer.create({
              data: {
                shopId: shopId!,
                name,
                phone,
                balance: total,
                totalSpent: total,
                totalOrders: 1,
                firstOrderAt: now,
                lastOrderAt: now,
              },
            });
            resolvedCustomerId = cust.id;
          }
        } else if (name && name !== "Walk-in Customer") {
          const cust = await tx.customer.create({
            data: { shopId: shopId!, name, balance: total, totalSpent: total, totalOrders: 1, firstOrderAt: now, lastOrderAt: now },
          });
          resolvedCustomerId = cust.id;
        }
      } else if (resolvedCustomerId) {
        const existing = await tx.customer.findUnique({ where: { id: resolvedCustomerId }, select: { firstOrderAt: true, deletedAt: true, shopId: true, balance: true, creditLimit: true } });
        if (!existing) {
          throw new AppError(404, "Customer not found");
        }
        if ((existing as any).shopId !== shopId && user.role !== "SUPER_ADMIN") {
          throw new AppError(403, "Customer belongs to another shop");
        }
        if (paymentMethod === "khata") {
          const canOverride = overrideLimit === true && (user.role === "SHOP_OWNER" || user.role === "SUPER_ADMIN");
          if (!canOverride && (existing as any).creditLimit != null) {
            const bal = dec((existing as any).balance);
            const lim = dec((existing as any).creditLimit);
            if (bal + Number(total) > lim) {
              throw new AppError(422, `Credit limit exceeded (balance ${bal.toFixed(2)} + bill ${Number(total).toFixed(2)} > limit ${lim.toFixed(2)})`, "CREDIT_LIMIT_EXCEEDED");
            }
          }
        }
        const isFirst = !existing?.firstOrderAt;
        await tx.customer.update({
          where: { id: resolvedCustomerId },
          data: {
            totalSpent: { increment: total },
            totalOrders: { increment: 1 },
            lastOrderAt: now,
            ...(isFirst ? { firstOrderAt: now } : {}),
            ...(existing?.deletedAt ? { deletedAt: null } : {}),
            ...(paymentMethod === "khata" ? { balance: { increment: total } } : {}),
          },
        });
      }

      // Resolve costPrice from DB — never trust client cost (profit manipulation).
      const prodIds = (items as Record<string, unknown>[])
        .filter((it) => !it.isCustom && it.productId)
        .map((it) => String(it.productId));
      const dbProds = prodIds.length
        ? await tx.product.findMany({ where: { id: { in: prodIds } }, select: { id: true, costPrice: true, shopId: true, deletedAt: true, stockQuantity: true } })
        : [];
      const costMap = new Map<string, number>(dbProds.map((p) => [p.id, dec((p as any).costPrice)]));
      const prodById = new Map(dbProds.map((p) => [p.id, p]));
      // Fail fast on missing/foreign/deleted products before creating the order
      for (const it of items as Record<string, unknown>[]) {
        if (!it.isCustom && it.productId) {
          const pid = String(it.productId);
          const prod = prodById.get(pid) as any;
          if (!prod) throw new AppError(404, `Product ${(it as any).name} not found`);
          if (prod.shopId && prod.shopId !== shopId && user.role !== "SUPER_ADMIN") {
            throw new AppError(403, `Product ${(it as any).name} does not belong to your shop`);
          }
          if (prod.deletedAt) throw new AppError(404, `Product ${(it as any).name} is deleted`);
        }
      }

      // Create order with shop/counter/user tracking — orderNumber already shop-unique with random tail, no retry needed
      const createdOrder = await tx.order.create({
        data: {
          orderNumber,
          shopId: shopId!,
          counterId: counterId ? String(counterId) : null,
          userId: user.userId,
          total: round2(Number(total)),
          discount: round2(Number(discount)),
          paymentMethod,
          customerId: resolvedCustomerId,
          status,
          ...(paymentMethod === "split" ? { cashAmount: tenderCash, upiAmount: tenderUpi } : {}),
          ...(idemKey ? { idempotencyKey: idemKey, idempotencyFingerprint: orderFingerprint } : {}),
          items: {
            create: (items as Record<string, unknown>[]).map((it) => {
              const pid = (it.productId as string) || null;
              const customCost = it.costPrice != null ? parseMoney(it.costPrice) : NaN;
              return {
                productId: pid,
                name: String(it.name),
                price: round2(Number(it.price)),
                unit: String(it.unit ?? "pcs"),
                quantity: it.quantity != null ? Number(it.quantity) : null,
                weight: it.weight != null ? Number(it.weight) : null,
                lineTotal: round2(Number(it.lineTotal)),
                isCustom: Boolean(it.isCustom),
                costPrice: pid && !it.isCustom ? (costMap.get(pid) ?? 0) : isNaN(customCost) ? null : customCost,
                category: it.category ? String(it.category) : null,
              };
            }),
          },
        },
        include: { items: true, customer: true },
      });

      if (paymentMethod === "khata" && resolvedCustomerId) {
        const daysInput = Number(creditDays ?? customDays);
        const days = Number.isNaN(daysInput) || daysInput <= 0 ? 30 : Math.min(365, Math.max(1, Math.round(daysInput)));
        const dueDate = computeDueDate(days);
        await tx.ledgerEntry.create({
          data: {
            shopId: shopId!,
            counterId: counterId ? String(counterId) : null,
            userId: user.userId,
            customerId: resolvedCustomerId,
            orderId: createdOrder.id,
            amount: round2(Number(total)),
            creditDays: days,
            dueDate,
            status: "pending",
          },
        });
      }

      // Stock decrement — conditional per-item (validated above in one batched fetch).
      // N updateMany (atomic per row) + 1 batched after-read for warnings (was 3N).
      const decrementedIds: string[] = [];
      for (const it of items as Record<string, unknown>[]) {
        if (!it.isCustom && it.productId) {
          const qty = Number(it.quantity ?? it.weight ?? 1);
          if (qty <= 0) continue;
          // Attempt conditional decrement
          const res = await tx.product.updateMany({
            where: { id: String(it.productId), stockQuantity: { gte: qty } },
            data: { stockQuantity: { decrement: qty } },
          });
          if ((res as any).count === 0) {
            // insufficient stock
            const fresh = await tx.product.findUnique({ where: { id: String(it.productId) }, select: { stockQuantity: true, name: true } });
            throw new AppError(409, `Insufficient stock for ${fresh?.name ?? (it as any).name}. Available: ${dec((fresh as any)?.stockQuantity) ?? 0}, requested: ${qty}`);
          }
          decrementedIds.push(String(it.productId));
        }
      }
      if (decrementedIds.length) {
        const afters = await tx.product.findMany({ where: { id: { in: decrementedIds } }, select: { id: true, stockQuantity: true, name: true, lowStockThreshold: true, unit: true } });
        for (const after of afters) {
          if (dec((after as any).stockQuantity) <= dec((after as any).lowStockThreshold ?? 10)) {
            lowStockWarnings.push({
              productId: (after as any).id,
              name: (after as any).name,
              stockQuantity: dec((after as any).stockQuantity),
              lowStockThreshold: dec((after as any).lowStockThreshold ?? 10),
              unit: (after as any).unit ?? "pcs",
            });
          }
        }
      }

      return createdOrder;
        });
        break;
      } catch (txErr) {
        const msg = txErr instanceof Error ? txErr.message : "";
        const isOrderNumberConflict =
          (msg.includes("P2002") || msg.includes("Unique constraint")) &&
          (msg.includes("orderNumber") || msg.includes("Order_orderNumber"));
        // Idempotency conflicts bubble to the outer handler (returns winner).
        // Order-number races retry with a fresh random tail.
        if (!isOrderNumberConflict) throw txErr;
        orderNumberConflict = txErr;
        continue;
      }
    }
    if (!order) {
      if (orderNumberConflict) throw orderNumberConflict;
      throw new AppError(500, "Failed to create order");
    }

    try {
      const { invalidateAnalyticsCache } = await import("./analytics.js");
      invalidateAnalyticsCache();
    } catch {
      // cache is best-effort
    }
    return c.json({ order, lowStockWarnings }, 201);
  } catch (e) {
    // Race fallback: two same-key requests passed the pre-check together — the loser
    // hits the unique constraint. Return the winner instead of a duplicate/409.
    if (idemKey) {
      const msg = e instanceof Error ? e.message : "";
      if (msg.includes("P2002") || msg.includes("Unique constraint") || msg.includes("idempotency")) {
        try {
          const winner = (await findIdempotentOrder!()) as any;
          if (winner && !(winner as any).deletedAt) {
            if ((winner as any).idempotencyFingerprint && (winner as any).idempotencyFingerprint !== orderFingerprint) {
              return c.json({ error: "Idempotency-Key already used for a different bill", code: "IDEMPOTENCY_KEY_REUSED" }, 422);
            }
            return c.json({ order: winner, lowStockWarnings: [], idempotentReplay: true });
          }
        } catch {
          // fall through to normal error
        }
      }
    }
    console.error("[POST /orders]", e);
    const appErr = toAppError(e);
    return c.json({ error: appErr.message, code: appErr.code }, appErr.status as 400 | 404 | 409 | 422 | 500 | 503);
  }
});

// DELETE /api/orders/:id — void with reversal. Blocked when a ledger entry is linked:
// settle/delete the ledger first so khata balances never diverge silently.
orders.delete("/:id", async (c) => {
  const id = c.req.param("id");
  const { user, shopId } = getShopScope(c);
  try {
    const existing = await prisma.order.findUnique({
      where: { id },
      include: { items: true, ledgerEntries: { where: { deletedAt: null } } },
    });
    if (!existing || (existing as any).deletedAt) return c.json({ error: "Not found" }, 404);
    if (shopId && (existing as any).shopId && (existing as any).shopId !== shopId && user.role !== "SUPER_ADMIN") return c.json({ error: "Forbidden" }, 403);
    if ((existing as any).ledgerEntries?.length > 0) {
      return c.json(
        { error: "Order has linked khata entries — settle or delete them first", code: "LEDGER_LINKED", ledgerEntryIds: (existing as any).ledgerEntries.map((e: any) => e.id) },
        409
      );
    }
    const orderTotal = Number((existing as any).total ?? 0);
    const customerId = (existing as any).customerId as string | null;
    await prisma.$transaction(async (tx) => {
      const upd = await tx.order.updateMany({ where: { id, deletedAt: null }, data: { deletedAt: new Date() } });
      if (upd.count === 0) return;
      // Restore stock for non-custom items
      for (const it of (existing as any).items ?? []) {
        if (!it.isCustom && it.productId) {
          const qty = Number(it.quantity ?? it.weight ?? 0);
          if (qty > 0) {
            await tx.product.updateMany({ where: { id: String(it.productId) }, data: { stockQuantity: { increment: qty } } });
          }
        }
      }
      // Reverse customer aggregates (totalSpent/totalOrders; balance untouched — no ledger linked by guard above)
      if (customerId) {
        await tx.customer.updateMany({
          where: { id: customerId },
          data: { totalSpent: { decrement: orderTotal }, totalOrders: { decrement: 1 } },
        });
        // Clamp totalSpent at 0 (aggregates, not money owed) and recompute lastOrderAt
        const cust = await tx.customer.findUnique({ where: { id: customerId }, select: { totalSpent: true } });
        if (cust && Number((cust as any).totalSpent) < 0) {
          await tx.customer.update({ where: { id: customerId }, data: { totalSpent: 0 } });
        }
        const last = await tx.order.findFirst({ where: { customerId, deletedAt: null }, orderBy: { createdAt: "desc" }, select: { createdAt: true } });
        await tx.customer.update({ where: { id: customerId }, data: { lastOrderAt: last ? (last as any).createdAt : null } });
      }
    });
    const updated = await prisma.order.findUnique({ where: { id }, include: { items: true, customer: true } });
    return c.json({ order: updated, softDeleted: true });
  } catch (e) {
    const appErr = toAppError(e);
    return c.json({ error: appErr.message, code: appErr.code }, appErr.status as 400 | 404 | 409 | 422 | 500 | 503);
  }
});

orders.post("/:id/restore", async (c) => {
  const id = c.req.param("id");
  const { user, shopId } = getShopScope(c);
  try {
    const existing = await prisma.order.findUnique({ where: { id }, include: { items: true } });
    if (!existing) return c.json({ error: "Not found" }, 404);
    if (!(existing as any).deletedAt) return c.json({ order: existing, message: "Already active" });
    if (shopId && (existing as any).shopId && (existing as any).shopId !== shopId && user.role !== "SUPER_ADMIN") return c.json({ error: "Forbidden" }, 403);
    const orderTotal = Number((existing as any).total ?? 0);
    const customerId = (existing as any).customerId as string | null;
    try {
      await prisma.$transaction(async (tx) => {
        // Re-apply stock with availability check — fail if product deleted or insufficient
        for (const it of (existing as any).items ?? []) {
          if (!it.isCustom && it.productId) {
            const qty = Number(it.quantity ?? it.weight ?? 0);
            if (qty <= 0) continue;
            const prod = await tx.product.findUnique({ where: { id: String(it.productId) } });
            if (!prod || (prod as any).deletedAt) throw new AppError(409, `Cannot restore — product ${(it as any).name} is deleted`);
            const res = await tx.product.updateMany({
              where: { id: String(it.productId), stockQuantity: { gte: qty } },
              data: { stockQuantity: { decrement: qty } },
            });
            if ((res as any).count === 0) {
              const fresh = await tx.product.findUnique({ where: { id: String(it.productId) }, select: { stockQuantity: true, name: true } });
              throw new AppError(409, `Cannot restore — insufficient stock for ${fresh?.name ?? (it as any).name}`);
            }
          }
        }
        const upd = await tx.order.updateMany({ where: { id, deletedAt: { not: null } }, data: { deletedAt: null } });
        if (upd.count === 0) return;
        if (customerId) {
          await tx.customer.update({ where: { id: customerId }, data: { totalSpent: { increment: orderTotal }, totalOrders: { increment: 1 }, lastOrderAt: new Date() } });
        }
      });
    } catch (txErr) {
      const appErr = toAppError(txErr);
      return c.json({ error: appErr.message, code: appErr.code }, appErr.status as 400 | 404 | 409 | 500 | 503);
    }
    const restored = await prisma.order.findUnique({ where: { id }, include: { items: true, customer: true } });
    return c.json({ order: restored });
  } catch (e) {
    const appErr = toAppError(e);
    return c.json({ error: appErr.message, code: appErr.code }, appErr.status as 400 | 404 | 409 | 500 | 503);
  }
});

export default orders;
